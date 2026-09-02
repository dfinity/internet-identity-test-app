import type { Identity } from "@icp-sdk/core/agent";
import type { DelegationChain } from "@icp-sdk/core/identity";
import { Principal } from "@icp-sdk/core/principal";
import {
  AuthClient,
  CookieStateStorage,
  IdbCredentialStorage,
  LocalCredentialStorage,
  LocalStateStorage,
  MemoryCredentialStorage,
  MemoryStateStorage,
  SessionGoneError,
  SharedMemoryCredentialStorage,
  type CredentialStorage,
  type StateStorage,
} from "@icp-sdk/auth/client";

/**
 * The page-lifetime AuthClient and the panel that reports what it is doing.
 *
 * The client has to outlive a sign-in: everything the session model does happens
 * between calls and across loads, so a client constructed per ceremony would never
 * restore one.
 */

/** Chosen before the client exists, so it survives the reload that applies it. */
const STORAGE_CHOICE_KEY = "test-app-storage-choice";

export interface StorageChoice {
  /** Where the two public facts about the sign-in live. Read synchronously. */
  state: "local" | "cookie" | "memory";
  /** Where the key and its delegation live, as one credential per slot. */
  credential: "idb" | "local" | "memory" | "shared-memory";
  cookieDomain: string;
  /**
   * Overrides what the state store says about being resumable, so a
   * cross-origin arrangement can opt in and siblings can opt out. Unset leaves
   * the store's own answer, which is only true for the cookie.
   */
  resumable?: boolean;
  /**
   * Minutes a session may go unminted before the provider ends it. Blank leaves
   * the provider's own default, currently seven days.
   */
  maxIdleMinutes: string;
  /**
   * The provider a session belongs to, kept so a second tab of this origin is
   * configured the same way. Without it a fresh tab falls back to the default
   * identity provider and refuses the stored session, because the chain names a
   * canister the client was never told about.
   */
  iiUrl: string;
  iiCanisterId: string;
  useIcrc25: boolean;
  /** False asks for an ICRC-34 app delegation instead of a session. */
  useSession: boolean;
}

const DEFAULT_CHOICE: StorageChoice = {
  state: "local",
  credential: "idb",
  cookieDomain: "",
  maxIdleMinutes: "",
  iiUrl: "",
  iiCanisterId: "",
  // Matches the `checked` attribute in index.html, which is there so the box is
  // right before this code runs. This is what applies it from then on, so the two
  // have to agree.
  useIcrc25: true,
  // Matches the `checked` attribute in index.html, as `useIcrc25` does.
  useSession: true,
};

export const readStorageChoice = (): StorageChoice => {
  try {
    const raw = window.localStorage.getItem(STORAGE_CHOICE_KEY);
    return raw === null
      ? DEFAULT_CHOICE
      : { ...DEFAULT_CHOICE, ...(JSON.parse(raw) as Partial<StorageChoice>) };
  } catch {
    return DEFAULT_CHOICE;
  }
};

export const writeStorageChoice = (choice: StorageChoice): void => {
  window.localStorage.setItem(STORAGE_CHOICE_KEY, JSON.stringify(choice));
};

export interface SessionClientParams {
  /** Empty or absent leaves the client on its own default provider. */
  authorizeUrl?: string;
  canisterId?: string;
  derivationOrigin?: string;
  transport?: "window" | "redirect";
  agentOptions?: { host?: string; shouldFetchRootKey?: boolean };
  choice: StorageChoice;
}

/**
 * The chain an identity is currently presenting, or `undefined`.
 *
 * Read by shape rather than by `instanceof`: the class this module imports and the
 * one `AuthClient` constructs are not guaranteed to be the same object, and a
 * failed identity check would show as a missing delegation rather than an error.
 */
const heldChain = (
  identity: Identity | undefined,
): DelegationChain | undefined => {
  const candidate = identity as
    | { getDelegation?: () => DelegationChain }
    | undefined;
  return typeof candidate?.getDelegation === "function"
    ? candidate.getDelegation()
    : undefined;
};

/** An identity that can be asked to replace its app delegation now. */
const refreshable = (
  identity: Identity | undefined,
): { refresh: () => Promise<void> } | undefined => {
  const candidate = identity as { refresh?: () => Promise<void> } | undefined;
  return typeof candidate?.refresh === "function"
    ? (candidate as { refresh: () => Promise<void> })
    : undefined;
};

/** Milliseconds until the earliest expiry in a chain, which is when it stops working. */
/**
 * Milliseconds until the earliest expiry in a chain, which is when it stops
 * working, or `undefined` for a chain carrying no delegations. `Math.min()` over
 * an empty list is `Infinity`, which formats as an em dash and reads as "nothing
 * here" rather than as the anomaly it is.
 */
const expiryMs = (chain: DelegationChain): number | undefined =>
  chain.delegations.length === 0
    ? undefined
    : Math.min(
        ...chain.delegations.map(({ delegation }) =>
          Number(delegation.expiration / BigInt(1_000_000)),
        ),
      );

const formatRemaining = (ms: number): string => {
  if (!Number.isFinite(ms)) return "-";
  if (ms <= 0) return "expired";
  const total = Math.floor(ms / 1000);
  const units: [number, string][] = [
    [Math.floor(total / 86400), "d"],
    [Math.floor((total % 86400) / 3600), "h"],
    [Math.floor((total % 3600) / 60), "m"],
    [total % 60, "s"],
  ];
  return units
    .filter(([value], index) => value > 0 || index >= 2)
    .map(([value, unit]) => `${value}${unit}`)
    .join(" ");
};

/**
 * Renders a countdown, or says what is wrong when there is no expiry to render.
 * A chain that exists but carries nothing is a state worth naming, since this
 * panel exists to make such a thing visible rather than blank.
 */
const describeExpiry = (
  expiry: number | undefined,
  chain: DelegationChain,
): string =>
  expiry === undefined
    ? `held, but it carries no delegations (${chain.delegations.length})`
    : formatRemaining(expiry - Date.now());

const shortPrincipal = (principal: Principal): string => {
  const text = principal.toText();
  return text.length > 28 ? `${text.slice(0, 14)}…${text.slice(-9)}` : text;
};

export interface SessionClientHandle {
  client: AuthClient;
  stateStorage: StateStorage;
  credentialStorage: CredentialStorage;
  params: SessionClientParams;
}

/** The provider fields the homepage form owns. Storage is the panel's own. */
export interface ProviderParams {
  authorizeUrl?: string;
  canisterId?: string;
  derivationOrigin?: string;
  /**
   * How the client should reach the network it mints against. Needed off
   * mainnet: the agent it builds defaults to not fetching the root key, so
   * certificates from a local replica fail verification with a `TrustError`.
   */
  agentOptions?: { host?: string; shouldFetchRootKey?: boolean };
}

const stateStorageFor = (choice: StorageChoice): StateStorage => {
  // A cookie store needs a domain to publish under; without one there is nothing
  // for a sibling to read, so the local store is the honest fallback.
  if (choice.state === "cookie" && choice.cookieDomain !== "") {
    return new CookieStateStorage({ domain: choice.cookieDomain });
  }
  return choice.state === "memory"
    ? new MemoryStateStorage()
    : new LocalStateStorage();
};

const credentialStorageFor = (choice: StorageChoice): CredentialStorage => {
  switch (choice.credential) {
    case "local":
      return new LocalCredentialStorage();
    case "memory":
      return new MemoryCredentialStorage();
    case "shared-memory":
      return new SharedMemoryCredentialStorage();
    default:
      return new IdbCredentialStorage();
  }
};

export const createSessionClient = (
  params: SessionClientParams,
): SessionClientHandle => {
  const stateStorage = stateStorageFor(params.choice);
  const credentialStorage = credentialStorageFor(params.choice);

  const client = new AuthClient({
    identityProvider: {
      authorizeUrl:
        params.authorizeUrl === undefined || params.authorizeUrl === ""
          ? undefined
          : params.authorizeUrl,
      canisterId:
        params.canisterId === undefined || params.canisterId === ""
          ? undefined
          : params.canisterId,
    },
    derivationOrigin: params.derivationOrigin,
    transport: params.transport,
    agentOptions: params.agentOptions,
    stateStorage,
    credentialStorage,
    // Unset leaves the store's own answer, which is what an application would
    // normally want; the panel exposes it so both directions are testable.
    resumable: params.choice.resumable,
  });

  return { client, stateStorage, credentialStorage, params };
};

/**
 * Renders the client's state, and notices the delegation being replaced.
 *
 * A mint is not announced: `onMinted` is internal to AuthClient and `subscribe`
 * does not fire for it, so a replacement is found by comparing the delegation's
 * expiry rather than reported by the library. The log therefore states what it
 * can see (the delegation changed, and when) alongside what this page itself did,
 * and never guesses which of the two caused the other.
 */
export const mountSessionPanel = (options: {
  /** Read live, so an edit to the provider fields takes effect on the next build. */
  readProvider: () => ProviderParams;
  /** Hands the page the client it should sign in with, including after a rebuild. */
  onClient: (handle: SessionClientHandle) => void;
  /**
   * Whatever identity the page itself holds. The legacy sign-in path does not go
   * through this client, so without this an app that is signed in that way is
   * indistinguishable here from one that is not signed in at all.
   */
  appIdentity?: () => Identity | undefined;
}): { log: (message: string) => void } => {
  const entries: string[] = [];
  let lastMessage: string | undefined;
  let repeats = 0;
  const log = (message: string) => {
    const stamp = new Date().toISOString().slice(11, 23);
    // The panel polls, so a persistent failure would otherwise arrive twice a
    // second and bury everything before it.
    if (message === lastMessage) {
      repeats += 1;
      entries[0] = `${stamp}  ${message}  (x${repeats + 1})`;
      const node = document.getElementById("sessionLog");
      if (node !== null) node.textContent = entries.slice(0, 200).join("\n");
      return;
    }
    lastMessage = message;
    repeats = 0;
    entries.unshift(`${stamp}  ${message}`);
    const node = document.getElementById("sessionLog");
    if (node !== null) node.textContent = entries.slice(0, 200).join("\n");
  };

  const control = (id: string) =>
    document.getElementById(id) as HTMLInputElement | null;

  // The radios and the domain field are the source of truth once the panel is up;
  // the stored copy exists for the redirect callback, which is a separate load.
  const choiceFromControls = (): StorageChoice => ({
    state:
      control("stateStorageCookie")?.checked === true
        ? "cookie"
        : control("stateStorageMemory")?.checked === true
          ? "memory"
          : "local",
    credential:
      control("credentialStorageLocal")?.checked === true
        ? "local"
        : control("credentialStorageMemory")?.checked === true
          ? "memory"
          : control("credentialStorageShared")?.checked === true
            ? "shared-memory"
            : "idb",
    // Three states, so a checkbox will not do: unset means "whatever the store
    // says", which is the case an application is normally in.
    resumable:
      control("resumableOn")?.checked === true
        ? true
        : control("resumableOff")?.checked === true
          ? false
          : undefined,
    maxIdleMinutes: control("sessionMaxIdle")?.value.trim() ?? "",
    cookieDomain: control("sessionCookieDomain")?.value.trim() ?? "",
    iiUrl: control("iiUrl")?.value.trim() ?? "",
    iiCanisterId: control("iiCanisterId")?.value.trim() ?? "",
    useIcrc25: control("useIcrc25")?.checked === true,
    useSession: control("useSession")?.checked === true,
  });

  const stored = readStorageChoice();
  const setChecked = (id: string, value: boolean) => {
    const node = control(id);
    if (node !== null) node.checked = value;
  };
  setChecked("stateStorageLocal", stored.state === "local");
  setChecked("stateStorageCookie", stored.state === "cookie");
  setChecked("stateStorageMemory", stored.state === "memory");
  setChecked("credentialStorageIdb", stored.credential === "idb");
  setChecked("credentialStorageLocal", stored.credential === "local");
  setChecked("credentialStorageMemory", stored.credential === "memory");
  setChecked("credentialStorageShared", stored.credential === "shared-memory");
  setChecked("resumableDefault", stored.resumable === undefined);
  setChecked("resumableOn", stored.resumable === true);
  setChecked("resumableOff", stored.resumable === false);
  const maxIdleEl = control("sessionMaxIdle");
  if (maxIdleEl !== null) maxIdleEl.value = stored.maxIdleMinutes;
  const domainEl = control("sessionCookieDomain");
  if (domainEl !== null) domainEl.value = stored.cookieDomain;

  // Restored before the client is built, so it is built from the same provider
  // the stored session was obtained from.
  const setValue = (id: string, value: string) => {
    const node = control(id);
    if (node !== null && value !== "") node.value = value;
  };
  setValue("iiUrl", stored.iiUrl);
  setValue("iiCanisterId", stored.iiCanisterId);
  const icrc25El = control("useIcrc25");
  if (icrc25El !== null) icrc25El.checked = stored.useIcrc25;

  const build = (): SessionClientHandle =>
    createSessionClient({
      ...options.readProvider(),
      choice: choiceFromControls(),
    });

  let handle = build();
  options.onClient(handle);

  const setText = (id: string, value: string) => {
    const node = document.getElementById(id);
    if (node !== null) node.textContent = value;
  };

  let identity: Identity | undefined;
  let sessionKeyPrincipal: Principal | undefined;
  let lastDelegationExpiry: number | undefined;
  let delegationChanges = 0;

  const render = () => {
    const status = handle.client.getStatus();
    // The record itself, rather than what the client makes of it: a sibling reads
    // the same bytes and derives `held` per origin, so this is what shows a shared
    // sign-in this origin cannot yet act with. The session chain is no longer here
    // — it lives in the credential store — so the expiry comes off the record.
    const record = handle.stateStorage.get();
    const sessionExpiryMs =
      record === null
        ? undefined
        : Number(record.expiration / BigInt(1_000_000));

    // Four cases the library orders for us, rather than a boolean this page
    // would have to interpret. `signed-in-elsewhere` is the one worth seeing:
    // a sibling holds the sign-in and this origin has no credential for it yet.
    setText(
      "sessionState",
      status.status === "signed-out" && options.appIdentity?.() !== undefined
        ? "signed in without a session — the legacy protocol path does not create one"
        : status.status,
    );
    setText(
      "sessionAccountPrincipal",
      status.status === "signed-out" ? "-" : status.principal.toText(),
    );
    setText(
      "sessionExpiry",
      sessionExpiryMs === undefined
        ? "-"
        : formatRemaining(sessionExpiryMs - Date.now()),
    );

    // `getDelegation()` falls back to the session chain when nothing has been
    // minted, so a chain expiring with the session is not an app delegation.
    const chain = heldChain(identity);
    const chainExpiry = chain === undefined ? undefined : expiryMs(chain);
    // Until something is minted the identity presents an empty chain rooted at the
    // account key, which is how it answers for the account principal with nothing
    // in hand. An empty chain therefore means no app delegation, not a broken one.
    const delegation =
      chain !== undefined && chain.delegations.length > 0 ? chain : undefined;
    setText(
      "delegationExpiry",
      record === null
        ? "-"
        : delegation === undefined
          ? "none held"
          : describeExpiry(chainExpiry, delegation),
    );
    setText("delegationChanges", String(delegationChanges));

    if (delegation === undefined) {
      if (lastDelegationExpiry !== undefined) {
        lastDelegationExpiry = undefined;
        log("delegation gone");
      }
    } else if (chainExpiry === undefined) {
      // Unreachable: a non-empty chain always has an earliest expiry.
    } else {
      if (lastDelegationExpiry === undefined) {
        lastDelegationExpiry = chainExpiry;
        log(
          `holding a delegation until ${new Date(chainExpiry).toISOString()}`,
        );
      } else if (chainExpiry !== lastDelegationExpiry) {
        lastDelegationExpiry = chainExpiry;
        delegationChanges += 1;
        log(
          `delegation replaced, now until ${new Date(chainExpiry).toISOString()}`,
        );
      }
    }

    setText(
      "sessionHint",
      record === null
        ? "none"
        : `${shortPrincipal(record.principal)} until ${new Date(
            sessionExpiryMs ?? 0,
          ).toISOString()}${record.held ? "" : " (not held here)"}`,
    );
    // What the client actually sends, which is the option where one is set and the
    // store's own answer otherwise — not the store's answer alone, or forcing it off
    // would still read as yes.
    const storeSays = handle.stateStorage.resumable === true;
    const effective = handle.params.choice.resumable ?? storeSays;
    setText(
      "sessionResumable",
      `${effective ? "yes" : "no"} (store says ${storeSays ? "yes" : "no"}${
        handle.params.choice.resumable === undefined ? "" : ", overridden"
      })`,
    );
  };

  // Called from an interval, a subscription and click handlers, all of which
  // discard the promise, so nothing outside can observe a rejection. Reading the
  // identity restores from storage and can fail; the countdowns should keep
  // running when it does, on the last identity that was readable.
  const refresh = async () => {
    try {
      identity = await handle.client.getIdentity();
    } catch (error) {
      log(
        `could not read the identity: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    render();
  };

  // The state store is what announces a change now, not the client: a sign-out in
  // another tab, or a sibling publishing a sign-in, both land as a state change.
  // A store whose medium cannot report one implements nothing, hence the `?.`.
  const listen = (h: SessionClientHandle) =>
    h.stateStorage.subscribe?.(() => {
      log("the state store reported a change");
      void refresh();
    });
  let unsubscribe = listen(handle);

  // Changing a setting replaces the client rather than asking for a reload.
  // `dispose` releases the old one's listeners, channel and identity and leaves
  // storage alone, so a session in progress survives being reconfigured.
  const rebuild = (what: string) => {
    unsubscribe?.();
    handle.client.dispose();
    handle = build();
    options.onClient(handle);
    unsubscribe = listen(handle);
    identity = undefined;
    lastDelegationExpiry = undefined;
    log(`${what} changed, client rebuilt`);
    void refresh();
  };

  // Every control the client is built from. Text fields settle on change rather
  // than on each keystroke, which is what makes rebuilding on edit reasonable.
  // Persisted on every keystroke, so a value typed and never blurred still
  // survives a reload. Rebuilding stays on `change`, since rebuilding the client
  // per keystroke would be absurd.
  for (const id of [
    "iiUrl",
    "iiCanisterId",
    "derivationOrigin",
    "sessionCookieDomain",
    "sessionMaxIdle",
  ]) {
    document.getElementById(id)?.addEventListener("input", () => {
      writeStorageChoice(choiceFromControls());
    });
  }

  // Persisted but not rebuilt on: the toggle selects which sign-in path the page
  // takes, which the client is not built from.
  for (const id of ["useIcrc25", "useSession"]) {
    document.getElementById(id)?.addEventListener("change", () => {
      writeStorageChoice(choiceFromControls());
    });
  }

  for (const id of [
    "iiUrl",
    "iiCanisterId",
    "derivationOrigin",
    "sessionCookieDomain",
    "stateStorageLocal",
    "stateStorageCookie",
    "stateStorageMemory",
    "credentialStorageIdb",
    "credentialStorageLocal",
    "credentialStorageMemory",
    "credentialStorageShared",
    "resumableDefault",
    "resumableOn",
    "resumableOff",
  ]) {
    document.getElementById(id)?.addEventListener("change", () => {
      // The redirect callback is a separate load and cannot read these controls,
      // so the storage choice is written down for it.
      writeStorageChoice(choiceFromControls());
      rebuild(id);
    });
  }

  // The delegation's expiry is the only externally visible sign that it was
  // replaced, so it is polled rather than waited on.
  window.setInterval(() => void refresh(), 500);
  document.addEventListener("visibilitychange", () =>
    log(`page became ${document.visibilityState}`),
  );
  window.addEventListener("pageshow", () => log("pageshow"));
  void refresh();

  const onClick = (id: string, run: () => Promise<void> | void) => {
    const node = document.getElementById(id);
    if (node === null) return;
    (node as HTMLButtonElement).onclick = () => {
      void (async () => {
        try {
          await run();
        } catch (error) {
          log(
            error instanceof SessionGoneError
              ? "SessionGoneError: the canister no longer holds this session"
              : `error: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        await refresh();
      })();
    };
  };

  onClick("sessionSignOutBtn", async () => {
    log("signOut requested");
    await handle.client.signOut();
    log("signOut returned, the session is ended at the canister");
  });

  onClick("sessionRefreshBtn", async () => {
    const target = refreshable(identity);
    if (target === undefined) {
      log("this identity cannot be asked to refresh");
      return;
    }
    log("refresh requested");
    await target.refresh();
    log("refresh returned");
  });

  onClick("sessionOpenTabBtn", () => {
    log("opening a second tab of this origin");
    window.open(window.location.href, "_blank", "noopener");
  });

  // `prompt` and `hint` are baked into the authorize URL at construction, so a
  // silent re-issue is its own client sharing this one's storage.
  onClick("sessionSilentBtn", async () => {
    // The record names the account to re-issue for, whichever store holds it.
    const hint = handle.stateStorage.get()?.principal;
    log(
      `silent re-auth requested${
        hint === undefined
          ? " with no hint"
          : ` hinting ${shortPrincipal(hint)}`
      }`,
    );
    const silent = new AuthClient({
      identityProvider: {
        authorizeUrl:
          handle.params.authorizeUrl === ""
            ? undefined
            : handle.params.authorizeUrl,
        canisterId:
          handle.params.canisterId === ""
            ? undefined
            : handle.params.canisterId,
      },
      derivationOrigin: handle.params.derivationOrigin,
      agentOptions: handle.params.agentOptions,
      stateStorage: handle.stateStorage,
      credentialStorage: handle.credentialStorage,
      prompt: "none",
      hint,
    });
    try {
      await silent.signIn();
      log("silent re-auth succeeded without rendering the provider");
    } finally {
      silent.dispose();
    }
  });

  return { log };
};

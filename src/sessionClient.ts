import type { Identity } from "@icp-sdk/core/agent";
import type { DelegationChain } from "@icp-sdk/core/identity";
import { Principal } from "@icp-sdk/core/principal";
import {
  AuthClient,
  CookieSessionStorage,
  IdbIdentityStorage,
  LocalIdentityStorage,
  LocalSessionStorage,
  SessionGoneError,
  type IdentityStorage,
  type Session,
  type SessionStorage,
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
  session: "local" | "cookie";
  identity: "idb" | "local";
  cookieDomain: string;
  /**
   * The provider a session belongs to, kept so a second tab of this origin is
   * configured the same way. Without it a fresh tab falls back to the default
   * identity provider and refuses the stored session, because the chain names a
   * canister the client was never told about.
   */
  iiUrl: string;
  iiCanisterId: string;
  useIcrc25: boolean;
}

const DEFAULT_CHOICE: StorageChoice = {
  session: "local",
  identity: "idb",
  cookieDomain: "",
  iiUrl: "",
  iiCanisterId: "",
  // Matches the `checked` attribute in index.html, which is there so the box is
  // right before this code runs. This is what applies it from then on, so the two
  // have to agree.
  useIcrc25: true,
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

/** The principal an application's canisters see, derived from the account key. */
const accountPrincipal = (session: Session): Principal =>
  Principal.selfAuthenticating(new Uint8Array(session.accountKey));

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
  sessionStorage: SessionStorage;
  params: SessionClientParams;
}

/** The provider fields the homepage form owns. Storage is the panel's own. */
export interface ProviderParams {
  authorizeUrl?: string;
  canisterId?: string;
  derivationOrigin?: string;
}

const storagesFor = (
  choice: StorageChoice,
): { session: SessionStorage; identity: IdentityStorage } => ({
  session:
    choice.session === "cookie" && choice.cookieDomain !== ""
      ? new CookieSessionStorage({ domain: choice.cookieDomain })
      : new LocalSessionStorage(),
  identity:
    choice.identity === "local"
      ? new LocalIdentityStorage()
      : new IdbIdentityStorage(),
});

export const createSessionClient = (
  params: SessionClientParams,
): SessionClientHandle => {
  const { session: sessionStorage, identity: identityStorage } = storagesFor(
    params.choice,
  );

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
    sessionStorage,
    identityStorage,
    // The panel is the point of the page; an idle timer reloading it would take
    // the log with it.
    idleOptions: { disableIdle: true },
  });

  return { client, sessionStorage, params };
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
    session:
      control("sessionStorageCookie")?.checked === true ? "cookie" : "local",
    identity:
      control("identityStorageLocal")?.checked === true ? "local" : "idb",
    cookieDomain: control("sessionCookieDomain")?.value.trim() ?? "",
    iiUrl: control("iiUrl")?.value.trim() ?? "",
    iiCanisterId: control("iiCanisterId")?.value.trim() ?? "",
    useIcrc25: control("useIcrc25")?.checked === true,
  });

  const stored = readStorageChoice();
  const setChecked = (id: string, value: boolean) => {
    const node = control(id);
    if (node !== null) node.checked = value;
  };
  setChecked("sessionStorageLocal", stored.session === "local");
  setChecked("sessionStorageCookie", stored.session === "cookie");
  setChecked("identityStorageIdb", stored.identity === "idb");
  setChecked("identityStorageLocal", stored.identity === "local");
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
  let lastDelegationExpiry: number | undefined;
  let delegationChanges = 0;

  const render = () => {
    const stored = handle.sessionStorage.get();

    setText(
      "sessionState",
      stored !== null
        ? "signed in"
        : options.appIdentity?.() !== undefined
          ? "signed in without a session — the legacy protocol path does not create one"
          : "no session",
    );
    setText(
      "sessionAccountPrincipal",
      stored === null ? "-" : accountPrincipal(stored).toText(),
    );
    const sessionPrincipal = identity?.getPrincipal();
    setText(
      "sessionSessionPrincipal",
      sessionPrincipal === undefined
        ? "-"
        : sessionPrincipal.isAnonymous()
          ? "anonymous"
          : sessionPrincipal.toText(),
    );
    setText(
      "sessionExpiry",
      stored === null
        ? "-"
        : describeExpiry(expiryMs(stored.chain), stored.chain),
    );

    // `getDelegation()` falls back to the session chain when nothing has been
    // minted, so a chain expiring with the session is not an app delegation.
    const chain = heldChain(identity);
    const sessionExpiry = stored === null ? undefined : expiryMs(stored.chain);
    const chainExpiry = chain === undefined ? undefined : expiryMs(chain);
    // A chain whose expiry cannot be read is still a chain, and saying so beats
    // reporting it as the session chain it is not.
    const delegation =
      chain !== undefined && chainExpiry !== sessionExpiry ? chain : undefined;
    setText(
      "delegationExpiry",
      stored === null
        ? "-"
        : delegation === undefined
          ? chain === undefined
            ? "none held"
            : "none held (the identity is presenting the session chain)"
          : describeExpiry(chainExpiry, delegation),
    );
    setText("delegationChanges", String(delegationChanges));

    if (delegation === undefined) {
      if (lastDelegationExpiry !== undefined) {
        lastDelegationExpiry = undefined;
        log("delegation gone");
      }
    } else if (chainExpiry === undefined) {
      // Worth a line of its own: a delegation that carries nothing is not a
      // state any requirement describes, so it is either a bug here or upstream.
      if (lastDelegationExpiry !== 0) {
        lastDelegationExpiry = 0;
        log(
          `holding a delegation that carries no delegations (${delegation.delegations.length})`,
        );
      }
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

    const hint =
      handle.sessionStorage instanceof CookieSessionStorage
        ? handle.sessionStorage.readHint()
        : null;
    setText(
      "sessionHint",
      hint === null
        ? "none"
        : `${shortPrincipal(hint.principal)} until ${new Date(
            hint.expiresAtMs,
          ).toISOString()}`,
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

  const listen = (h: SessionClientHandle) =>
    h.client.subscribe(() => {
      log("client reported a change");
      void refresh();
    });
  let unsubscribe = listen(handle);

  // Changing a setting replaces the client rather than asking for a reload.
  // `dispose` releases the old one's listeners, channel and identity and leaves
  // storage alone, so a session in progress survives being reconfigured.
  const rebuild = (what: string) => {
    unsubscribe();
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
  ]) {
    document.getElementById(id)?.addEventListener("input", () => {
      writeStorageChoice(choiceFromControls());
    });
  }

  // Persisted but not rebuilt on: the toggle selects which sign-in path the page
  // takes, which the client is not built from.
  document.getElementById("useIcrc25")?.addEventListener("change", () => {
    writeStorageChoice(choiceFromControls());
  });

  for (const id of [
    "iiUrl",
    "iiCanisterId",
    "derivationOrigin",
    "sessionCookieDomain",
    "sessionStorageLocal",
    "sessionStorageCookie",
    "identityStorageIdb",
    "identityStorageLocal",
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
    const stored = handle.sessionStorage.get();
    const hint =
      handle.sessionStorage instanceof CookieSessionStorage
        ? (handle.sessionStorage.readHint()?.principal ?? undefined)
        : stored === null
          ? undefined
          : accountPrincipal(stored);
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
      sessionStorage: handle.sessionStorage,
      idleOptions: { disableIdle: true },
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

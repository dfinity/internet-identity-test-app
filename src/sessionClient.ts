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
  SessionIdentity,
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
}

const DEFAULT_CHOICE: StorageChoice = {
  session: "local",
  identity: "idb",
  cookieDomain: "",
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

/** Milliseconds until the earliest expiry in a chain, which is when it stops working. */
const expiryMs = (chain: DelegationChain): number =>
  Math.min(
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
}): { log: (message: string) => void } => {
  const entries: string[] = [];
  const log = (message: string) => {
    const stamp = new Date().toISOString().slice(11, 23);
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

    setText("sessionState", stored === null ? "no session" : "signed in");
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
        : formatRemaining(expiryMs(stored.chain) - Date.now()),
    );

    const delegation =
      identity instanceof SessionIdentity
        ? identity.getDelegation()
        : undefined;
    setText(
      "delegationExpiry",
      delegation === undefined
        ? "-"
        : formatRemaining(expiryMs(delegation) - Date.now()),
    );
    setText("delegationChanges", String(delegationChanges));

    if (delegation === undefined) {
      if (lastDelegationExpiry !== undefined) {
        lastDelegationExpiry = undefined;
        log("delegation gone");
      }
    } else {
      const expiry = expiryMs(delegation);
      if (lastDelegationExpiry === undefined) {
        lastDelegationExpiry = expiry;
        log(`holding a delegation until ${new Date(expiry).toISOString()}`);
      } else if (expiry !== lastDelegationExpiry) {
        lastDelegationExpiry = expiry;
        delegationChanges += 1;
        log(`delegation replaced, now until ${new Date(expiry).toISOString()}`);
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
    if (!(identity instanceof SessionIdentity)) {
      log("no session identity to refresh");
      return;
    }
    log("refresh requested");
    await identity.refresh();
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

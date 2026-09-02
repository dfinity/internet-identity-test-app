import type { SignIdentity, Signature } from "@icp-sdk/core/agent";
import {
  Delegation,
  DelegationChain,
  DelegationIdentity,
  SignedDelegation,
} from "@icp-sdk/core/identity";
import { Principal } from "@icp-sdk/core/principal";
import { AuthClient } from "@icp-sdk/auth/client";
import { Signer } from "@icp-sdk/signer";
import { PostMessageTransport } from "@icp-sdk/signer/web";

// The type of response from II as per the spec
interface AuthResponseSuccess {
  kind: "authorize-client-success";
  delegations: {
    delegation: {
      pubkey: Uint8Array;
      expiration: bigint;
      targets?: Principal[];
    };
    signature: Uint8Array;
  }[];
  userPublicKey: Uint8Array;
  authnMethod: "pin" | "passkey" | "recovery";
}

export interface Icrc3Attributes {
  data: Uint8Array;
  signature: Uint8Array;
}

// Perform a sign in to II using parameters set in this app
export const authWithII = async ({
  url: url_,
  maxTimeToLive,
  maxTimeToIdle,
  allowPinAuthentication,
  derivationOrigin,
  sessionIdentity,
  authClient,
  autoSelectionPrincipal,
  useIcrc25,
  useSession,
  requestAttributes,
  icrc3Nonce,
}: {
  url: string;
  maxTimeToLive?: bigint;
  /** How long the session may go unminted before the provider ends it. */
  maxTimeToIdle?: bigint;
  allowPinAuthentication?: boolean;
  derivationOrigin?: string;
  autoSelectionPrincipal?: string;
  sessionIdentity: SignIdentity;
  /** The page's client, which owns the session and its storage. */
  authClient: AuthClient;
  useIcrc25?: boolean;
  /**
   * Whether to ask for a session, or for a plain app delegation.
   *
   * `ii_session_delegation` returns a chain the client mints short-lived app
   * delegations from, so the identity replaces its own credential as it ages.
   * `icrc34_delegation` returns the app delegation directly — the same kind of
   * identity, without the inner minting — and it expires when it expires.
   */
  useSession?: boolean;
  requestAttributes?: string[];
  icrc3Nonce?: Uint8Array;
}): Promise<{
  identity: DelegationIdentity;
  authnMethod: string;
  icrc3Attributes?: Icrc3Attributes;
}> => {
  // Authenticate via the ICRC-25 protocol
  if (useIcrc25) {
    if (useSession === false) {
      // ICRC-34: one delegation for the app's own key, and nothing after it.
      // Attributes are not requested here — II answers `ii_attributes` only for
      // a 1-click OpenID sign-in at a dapp allow-listed for certified
      // attributes, and stays silent otherwise, which would hang this call.
      const transport = new PostMessageTransport({ url: url_ });
      const signer = new Signer({ transport, derivationOrigin });
      try {
        const delegationChain = await signer.requestDelegation({
          publicKey: sessionIdentity.getPublicKey(),
          maxTimeToLive,
        });
        return {
          identity: DelegationIdentity.fromDelegation(
            sessionIdentity,
            delegationChain,
          ),
          authnMethod: "passkey",
        };
      } finally {
        await signer.closeChannel();
      }
    }

    const hasAttributes =
      requestAttributes !== undefined && requestAttributes.length > 0;

    const nonce = icrc3Nonce ?? crypto.getRandomValues(new Uint8Array(32));

    const [identity, icrc3Attributes] = await Promise.all([
      authClient.signIn({ maxTimeToLive, maxTimeToIdle }),
      hasAttributes
        ? authClient.requestAttributes({
            keys: requestAttributes,
            nonce: () => Promise.resolve(nonce),
          })
        : Promise.resolve(undefined),
    ]);

    if (!(identity instanceof DelegationIdentity)) {
      throw new Error(
        "Expected a DelegationIdentity from AuthClient.signIn, got " +
          identity.constructor.name,
      );
    }

    return {
      identity,
      authnMethod: "passkey",
      icrc3Attributes: icrc3Attributes ?? undefined,
    };
  }

  // Figure out the II URL to use
  const iiUrl = new URL(url_);
  iiUrl.hash = "#authorize";

  // Open an II window and kickstart the flow
  const win = window.open(iiUrl, "ii-window");
  if (win === null) {
    throw new Error(`Could not open window for '${iiUrl}'`);
  }

  // Wait for II to say it's ready
  const evnt = await new Promise<MessageEvent>((resolve) => {
    const readyHandler = (e: MessageEvent) => {
      if (e.origin !== iiUrl.origin) {
        // Ignore messages from other origins (e.g. from a metamask extension)
        return;
      }
      window.removeEventListener("message", readyHandler);
      resolve(e);
    };
    window.addEventListener("message", readyHandler);
  });

  if (evnt.data.kind !== "authorize-ready") {
    throw new Error("Bad message from II window: " + JSON.stringify(evnt));
  }

  // Send the request to II
  const sessionPublicKey: Uint8Array = new Uint8Array(
    sessionIdentity.getPublicKey().toDer(),
  );

  const request = {
    kind: "authorize-client",
    sessionPublicKey,
    maxTimeToLive,
    derivationOrigin,
    allowPinAuthentication,
    autoSelectionPrincipal,
  };

  win.postMessage(request, iiUrl.origin);

  // Wait for the II response and update the local state
  const response = await new Promise<MessageEvent>((resolve) => {
    const responseHandler = (e: MessageEvent) => {
      if (e.origin !== iiUrl.origin) {
        // Ignore messages from other origins (e.g. from a metamask extension)
        return;
      }
      window.removeEventListener("message", responseHandler);
      win.close();
      resolve(e);
    };
    window.addEventListener("message", responseHandler);
  });

  const message = response.data;
  if (message.kind !== "authorize-client-success") {
    throw new Error("Bad reply: " + JSON.stringify(message));
  }

  const identity = identityFromResponse({
    response: message as AuthResponseSuccess,
    sessionIdentity,
  });

  return { identity, authnMethod: message.authnMethod };
};

// Read delegations the delegations from the response
const identityFromResponse = ({
  sessionIdentity,
  response,
}: {
  sessionIdentity: SignIdentity;
  response: AuthResponseSuccess;
}): DelegationIdentity => {
  const delegations = response.delegations.map(extractDelegation);

  const delegationChain = DelegationChain.fromDelegations(
    delegations,
    response.userPublicKey,
  );

  const identity = DelegationIdentity.fromDelegation(
    sessionIdentity,
    delegationChain,
  );

  return identity;
};

// Infer the type of an array's elements
type ElementOf<Arr> = Arr extends readonly (infer ElementOf)[]
  ? ElementOf
  : "argument is not an array";

export const extractDelegation = (
  signedDelegation: ElementOf<AuthResponseSuccess["delegations"]>,
): SignedDelegation => ({
  delegation: new Delegation(
    signedDelegation.delegation.pubkey,
    signedDelegation.delegation.expiration,
    signedDelegation.delegation.targets,
  ),
  signature: signedDelegation.signature
    .buffer as Signature /* brand type for agent-js */,
});

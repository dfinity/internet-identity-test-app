/**
 * Wire types for the verifiable-credential flow this app drives as a relying
 * party.
 *
 * These mirror the request format Internet Identity accepts on the VC flow
 * `window.postMessage` channel; see the identity-provider API in
 * <https://github.com/dfinity/internet-identity/blob/main/docs/vc-spec.md>.
 * Only the request side is needed here, because the app posts the request and
 * reads the response back as opaque JSON.
 */

/** A credential specification, in the JSON shape II parses off the wire. */
export type CredentialSpecWire = {
  credentialType: string;
  arguments?: Record<string, string | number>;
};

/** The request that kicks off the VC flow (relying party -> II). */
export type VcFlowRequestWire = {
  /* jsonrpc allows fractional numbers as ids too, but II only ever sees the
   * values this app sends. */
  id: number | string;
  jsonrpc: "2.0";
  method: "request_credential";
  params: {
    issuer: {
      origin: string;
      canisterId: string;
    };
    credentialSpec: CredentialSpecWire;
    credentialSubject: string;
    derivationOrigin?: string;
  };
};

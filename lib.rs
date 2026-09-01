use crate::AlternativeOriginsMode::{CertifiedContent, Redirect};
use asset_util::{collect_assets, Asset, CertifiedAssets, ContentEncoding, ContentType};
use candid::{CandidType, Deserialize, Principal};
use ic_cdk::api;
use ic_cdk_macros::{init, post_upgrade, query, update};
use ii_notification_client::{well_known::SendersDocument, Notification, NotificationClient};
use include_dir::{include_dir, Dir};
use serde_bytes::ByteBuf;
use std::cell::RefCell;
use AlternativeOriginsMode::UncertifiedContent;

const ALTERNATIVE_ORIGINS_PATH: &str = "/.well-known/ii-alternative-origins";
const EVIL_ALTERNATIVE_ORIGINS_PATH: &str = "/.well-known/evil-alternative-origins";
// ICRC-167 URL transport auth-callback allow-list. Points at this app's redirect
// callback page (`/callback`), so II's URL transport accepts delivering a
// response back to it.
const AUTH_CALLBACKS_PATH: &str = "/.well-known/ii-auth-callbacks";
// Permissionless app display metadata (name, description, logo) read by II
// when it renders its authorization screens. Not served until a test sets it
// through `update_app_metadata`, so by default II falls back to whatever it
// knows about this origin on its own.
const APP_METADATA_PATH: &str = "/.well-known/ii-app-metadata";
const EVIL_APP_METADATA_PATH: &str = "/.well-known/evil-app-metadata";
// Notification sender allowlist II fetches (at consent) to authorize a
// canister as a sender for this origin. This canister lists itself.
const NOTIFICATION_SENDERS_PATH: &str = "/.well-known/ii-notification-senders";
const EMPTY_ALTERNATIVE_ORIGINS: &str = r#"{"alternativeOrigins":[]}"#;
const OUTDATED_INVALID_CERTIFICATE_HEADER: &str = ":2dn3omR0cmVlgwGDAYMBgwJIY2FuaXN0ZXKDAYMBggRYIF7eYW50QXA1hAANBQ4J616Ekjch0ihDxnNGwvlxxIKDgwGCBFggH4wduBeihx+gd8Oe2KvzyQxp/PEe6ustjHJNlVhLbmaDAkqAAAAAABAAAwEBgwGDAYMCTmNlcnRpZmllZF9kYXRhggNYIIA3JGAjACCVyCTmsRmhhlZDI5oDZZkhGVMbpCIFTEejggRYIIMJ950nCB4emD2uvICtY5WfLhcOzb2BaqH4EvUGTX2xggRYIFfnBG3quMbImRDu81QLZKq0ADXD75bQIoPHA2y4JRQVggRYIETEKmiZ1Lflrx8sIiDUOqBdb7X+mJ5+kEturndxJYzeggRYINPKhi8ZGTDLJJGHdaSlL3lxf8JFGiBHe3FVp4y/myCvggRYIIZ883QyMwhObp/SFU8xtXu8w8xGgwEWfkJYAWqC9dNSgwGCBFgg49iYnFVeAADyzEwGNNe…Bcfct/T4ZWVYbJe/P3gUbLOS8n9uDAklodHRwX2V4cHKDAYMBgwGCBFgggaSHI9J56LbuKjb58O8AWYlQNqTWZBxB58L7Y6u9j2ODAksud2VsbC1rbm93boMBggRYIJY8druSGXKdr/LHH3Kr/F+Vo9VwgluKJZS6HxkTrIeUgwJWaWktYWx0ZXJuYXRpdmUtb3JpZ2luc4MCQzwkPoMCWCBiB64Pds+kxrd7O3KKhS3TAcooPTqycnGLKWuiy3dP6IMCQIMCWCCaryvDtyyZdDWHqiLmkc63lZuPrBF2Tt6ULsG0LUkWcIIDQIIEWCAYA1f5ooQFb7bDDkKE0QhYJLkfsn2j1GCIGJvp8r8ucYIEWCB28Uo/B0pARPP3FnDUBj83i4NpGPehI4IGGI2I2iOQhg==:, expr_path=:2dn3hGlodHRwX2V4cHJrLndlbGwta25vd252aWktYWx0ZXJuYXRpdmUtb3JpZ2luc2M8JD4=:, version=2";

thread_local! {
    static ASSETS: RefCell<CertifiedAssets> = RefCell::new(CertifiedAssets::default());
    static ALTERNATIVE_ORIGINS_MODE: RefCell<AlternativeOriginsMode> = const { RefCell::new(CertifiedContent) };
}

#[query]
fn whoami() -> Principal {
    api::msg_caller()
}

/// Returned by [`caller_attributes`].
#[derive(Clone, Debug, CandidType, Deserialize)]
pub struct CallerAttributes {
    /// Canister that signed the attributes attached to the caller's
    /// request. `None` when the caller is another canister or the
    /// request didn't carry a `sender_info` field.
    pub signer: Option<Principal>,
    /// Raw attribute payload as provided by the signer. The format is
    /// signer-defined; for II this is a Candid-encoded ICRC-3 `Value`.
    pub data: ByteBuf,
}

/// Update entrypoint that echoes the caller's signed attributes back
/// to the client. Together with `AttributeIdentity` on the frontend
/// this lets e2e tests verify that a request originated by an II
/// authorize flow can be replayed against an arbitrary canister with
/// the attribute bundle still attached and validated by the IC.
#[update]
fn caller_attributes() -> CallerAttributes {
    CallerAttributes {
        signer: api::msg_caller_info_signer(),
        data: ByteBuf::from(api::msg_caller_info_data()),
    }
}

// ===== Notifications: send a test notification through II =====
//
// The frontend calls this after sign-in; this canister then calls II's
// `notification_send` as the (canister) sender, through the client crate every
// sending dApp is meant to use. II authorizes the caller by fetching this
// origin's `/.well-known/ii-notification-senders`, so this only works when the
// app runs at a public canister origin II can reach — not localhost. `origin` is
// the origin the user consented from (the frontend passes its own
// `window.location.origin`); `recipient` is the principal II handed this app at
// sign-in.

#[update]
async fn send_notification(ii: Principal, recipient: Principal, origin: String) -> String {
    let id = api::time().to_be_bytes().to_vec();
    let client = NotificationClient::new(ii, origin);
    match client.notify(vec![Notification::new(id, recipient)]).await {
        Ok(response) => format!(
            "accepted={} rejected={:?} retry_after_ms={:?} resend_epoch={:?}",
            response.accepted.unwrap_or(0),
            response.rejected.unwrap_or_default(),
            response.retry_after_ms,
            response.resend_epoch,
        ),
        Err(err) => format!("call failed: {err}"),
    }
}

/// Function to update the asset /.well-known/ii-alternative-origins.
/// # Arguments
/// * alternative_origins: new value of this asset. The content type will always be set to application/json.
/// * mode: enum that allows changing the behaviour of the asset. See [AlternativeOriginsMode].
#[update]
fn update_alternative_origins(alternative_origins: String, mode: AlternativeOriginsMode) {
    ASSETS.with_borrow_mut(|assets| {
        let asset = Asset {
            url_path: ALTERNATIVE_ORIGINS_PATH.to_string(),
            content: alternative_origins.as_bytes().to_vec(),
            encoding: ContentEncoding::Identity,
            content_type: ContentType::JSON,
        };
        match &mode {
            CertifiedContent | UncertifiedContent => assets.certify_asset(asset, &static_headers()),
            Redirect { location } => assets
                .certify_redirect(
                    ALTERNATIVE_ORIGINS_PATH,
                    location.as_str(),
                    &static_headers(),
                )
                .expect("Failed to certify alternative origins redirect"),
        }
    });

    ALTERNATIVE_ORIGINS_MODE.with(|m| {
        m.replace(mode);
    });
    update_root_hash()
}

/// Function to set the asset /.well-known/ii-app-metadata.
///
/// The document is taken as an opaque string rather than typed fields: II's
/// tests need to serve malformed JSON, oversized payloads and out-of-range
/// values, none of which a typed argument could express.
///
/// # Arguments
/// * app_metadata: new value of this asset. The content type will always be set to application/json.
/// * mode: enum that allows changing the behaviour of the asset. See [AppMetadataMode].
#[update]
fn update_app_metadata(app_metadata: String, mode: AppMetadataMode) {
    ASSETS.with_borrow_mut(|assets| match mode {
        AppMetadataMode::CertifiedContent => assets.certify_asset(
            Asset {
                url_path: APP_METADATA_PATH.to_string(),
                content: app_metadata.as_bytes().to_vec(),
                encoding: ContentEncoding::Identity,
                content_type: ContentType::JSON,
            },
            &static_headers(),
        ),
        AppMetadataMode::Redirect { location } => assets
            .certify_redirect(APP_METADATA_PATH, location.as_str(), &static_headers())
            .expect("Failed to certify app metadata redirect"),
    });
    update_root_hash()
}

pub type HeaderField = (String, String);

#[derive(Clone, Debug, CandidType, Deserialize)]
pub struct HttpRequest {
    pub method: String,
    pub url: String,
    pub headers: Vec<HeaderField>,
    pub body: ByteBuf,
    pub certificate_version: Option<u16>,
}

#[derive(Clone, Debug, CandidType, Deserialize)]
pub struct HttpResponse {
    pub status_code: u16,
    pub headers: Vec<HeaderField>,
    pub body: ByteBuf,
}

/// Enum of the available asset behaviours of /.well-known/ii-alternative-origins:
/// * CertifiedContent: Valid certification on the payload. This mode is required to successfully use one of the listed alternative origins.
/// * UncertifiedContent: No `IC-Certificate` header will be sent back with the response. This mode can be used to validate that II rejects uncertified assets when validating alternative origins.
/// * Redirect: This will set the response status code to 303 and a `Location` header with the value provided. This mode can be used to validate that II rejects redirects when validating alternative origins.
#[derive(Clone, Debug, CandidType, Deserialize)]
pub enum AlternativeOriginsMode {
    CertifiedContent,
    UncertifiedContent,
    Redirect { location: String },
}

/// Enum of the available asset behaviours of /.well-known/ii-app-metadata:
/// * CertifiedContent: Valid certification on the payload, i.e. the document is served as written.
/// * Redirect: This will set the response status code to 303 and a `Location` header with the value provided. This mode can be used to validate that II does not follow redirects when reading app metadata.
#[derive(Clone, Debug, CandidType, Deserialize)]
pub enum AppMetadataMode {
    CertifiedContent,
    Redirect { location: String },
}

#[query]
pub fn http_request(req: HttpRequest) -> HttpResponse {
    let parts: Vec<&str> = req.url.split('?').collect();
    let path = parts[0];

    match path {
        ALTERNATIVE_ORIGINS_PATH => ALTERNATIVE_ORIGINS_MODE.with_borrow(|mode| {
            let mut certified_response = certified_response(path, req.certificate_version)
                .expect("/.well-known/ii-alternative-origins must be certified");
            match mode {
                UncertifiedContent => {
                    certified_response.headers = certified_response
                        .headers
                        .into_iter()
                        .map(|(header_name, header_value)| {
                            // Modify the IC-Certificate header to make certification invalid
                            // Note: we cannot simply drop the header because the local replica
                            // skips the certification check altogether when the header is absent.
                            if header_name == "IC-Certificate" {
                                (header_name, OUTDATED_INVALID_CERTIFICATE_HEADER.to_string())
                            } else {
                                (header_name, header_value)
                            }
                        })
                        .collect::<_>()
                }
                Redirect { .. } | CertifiedContent => {
                    // don't tamper with the certified response
                }
            }
            certified_response
        }),
        path => certified_response(path, req.certificate_version)
            .unwrap_or_else(|| not_found_response(path)),
    }
}

fn certified_response(url: &str, max_certificate_version: Option<u16>) -> Option<HttpResponse> {
    let maybe_asset =
        ASSETS.with_borrow(|assets| assets.get_certified_asset(url, max_certificate_version, None));
    maybe_asset.map(|asset| {
        let mut headers = asset.headers;
        headers.extend(static_headers());
        HttpResponse {
            status_code: asset.status_code,
            headers,
            body: ByteBuf::from(asset.content),
        }
    })
}

fn not_found_response(path: &str) -> HttpResponse {
    HttpResponse {
        status_code: 404,
        headers: static_headers(),
        body: ByteBuf::from(format!("Asset {} not found.", path)),
    }
}

fn static_headers() -> Vec<HeaderField> {
    vec![
        ("Access-Control-Allow-Origin".to_string(), "*".to_string()),
        (
            "Referrer-Policy".to_string(),
            "strict-origin-when-cross-origin".to_string(),
        ),
    ]
}

// Assets
static ASSET_DIR: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/dist");

fn fixup_html(html: &str) -> String {
    let canister_id = api::canister_self();

    // the string we are replacing here is inserted by vite during the front-end build
    html.replace(
        r#"<script type="module" crossorigin src="/index.js"></script>"#,
        &format!(r#"<script data-canister-id="{canister_id}" type="module" crossorigin src="/index.js"></script>"#).to_string(),
    )
}

/// Optional install/upgrade argument.
#[derive(Clone, Debug, CandidType, Deserialize)]
pub struct InitArg {
    /// Extra callback URLs to add to the ICRC-167 auth-callback allow-list, on
    /// top of this canister's own gateway origins. Used to declare a custom
    /// domain the canister is also served under (e.g. the e2e `nice-name.com`).
    pub auth_callbacks: Vec<String>,
}

#[init]
pub fn init(arg: Option<InitArg>) {
    let extra_auth_callbacks = arg.map(|arg| arg.auth_callbacks).unwrap_or_default();
    init_assets(EMPTY_ALTERNATIVE_ORIGINS.to_string(), extra_auth_callbacks);
}
#[post_upgrade]
fn post_upgrade(arg: Option<InitArg>) {
    init(arg)
}

/// Collect all the assets from the dist folder.
fn init_assets(alternative_origins: String, extra_auth_callbacks: Vec<String>) {
    let mut assets = collect_assets(&ASSET_DIR, Some(fixup_html));
    assets.push(Asset {
        url_path: ALTERNATIVE_ORIGINS_PATH.to_string(),
        content: alternative_origins.as_bytes().to_vec(),
        encoding: ContentEncoding::Identity,
        content_type: ContentType::JSON,
    });

    // convenience asset to have an url to point to when testing with the redirect alternative origins behaviour
    assets.push(Asset {
        url_path: EVIL_ALTERNATIVE_ORIGINS_PATH.to_string(),
        content: b"{\"alternativeOrigins\":[\"https://evil.com\"]}".to_vec(),
        encoding: ContentEncoding::Identity,
        content_type: ContentType::JSON,
    });

    // convenience asset to have a URL to point to when testing with the
    // redirect app metadata behaviour. A document that would be perfectly valid
    // if it were read, so a test can tell "II didn't follow the redirect" apart
    // from "II read the redirect target and rejected it".
    assets.push(Asset {
        url_path: EVIL_APP_METADATA_PATH.to_string(),
        content: br#"{"name":"Evil App","description":"Served from the redirect target"}"#.to_vec(),
        encoding: ContentEncoding::Identity,
        content_type: ContentType::JSON,
    });

    // ICRC-167 URL transport auth-callback allow-list, declaring this app's
    // redirect callback page (`/callback`) so II's URL transport accepts a
    // redirect back to it. Covers this canister's own gateway origins (derived
    // from its id, so the deployed canister works without configuration) plus
    // any extra origins supplied at install (e.g. the e2e `nice-name.com`).
    // Certified like any other asset, so the HTTP gateway serves it and II's
    // cross-origin fetch (CORS allowed by `static_headers`) sees it.
    let canister_id = api::canister_self();
    let mut callbacks: Vec<String> = ["icp0.io", "ic0.app", "icp.net"]
        .iter()
        .map(|domain| format!("https://{canister_id}.{domain}/callback"))
        .collect();
    callbacks.extend(extra_auth_callbacks);
    // Serialize with serde_json so the callback strings — the derived ones are
    // safe, but `extra_auth_callbacks` come from the init argument — are always
    // properly escaped JSON string literals.
    let content = serde_json::json!({ "callbacks": callbacks }).to_string();
    assets.push(Asset {
        url_path: AUTH_CALLBACKS_PATH.to_string(),
        content: content.into_bytes(),
        encoding: ContentEncoding::Identity,
        content_type: ContentType::JSON,
    });

    // Sender allowlist: authorize this canister to send notifications for its
    // own origin. II fetches this at consent time.
    let senders = SendersDocument::new([canister_id]).to_json();
    assets.push(Asset {
        url_path: NOTIFICATION_SENDERS_PATH.to_string(),
        content: senders.into_bytes(),
        encoding: ContentEncoding::Identity,
        content_type: ContentType::JSON,
    });
    ASSETS.with_borrow_mut(|certified_assets| {
        *certified_assets = CertifiedAssets::certify_assets(assets, &static_headers());
    });
    update_root_hash()
}

fn update_root_hash() {
    ASSETS.with_borrow(|assets| {
        api::certified_data_set(&assets.root_hash()[..]);
    })
}

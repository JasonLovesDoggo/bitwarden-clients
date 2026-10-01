use std::sync::Arc;

#[cfg(feature = "napi")]
use napi_derive::napi;
use serde::{Deserialize, Serialize};

use crate::{BitwardenError, Callback, TimedCallback};

/// A password identity explicitly selected from the system's suggestions.
#[cfg_attr(feature = "napi", napi(object, namespace = "autofill"))]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PasswordCredentialRequest {
    pub record_identifier: String,
    pub service_identifier: String,
    pub username: String,
    pub context: String,
}

/// Passwords must not be included in Debug output or persisted by the extension.
#[cfg_attr(feature = "napi", napi(object, namespace = "autofill"))]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PasswordCredentialResponse {
    pub username: String,
    pub password: String,
}

#[cfg_attr(feature = "uniffi", uniffi::export(with_foreign))]
pub trait PreparePasswordCredentialCallback: Send + Sync {
    fn on_complete(&self, credential: PasswordCredentialResponse);
    fn on_error(&self, error: BitwardenError);
}

impl Callback for Arc<dyn PreparePasswordCredentialCallback> {
    fn complete(&self, credential: serde_json::Value) -> Result<(), serde_json::Error> {
        let credential = serde_json::from_value(credential)?;
        self.on_complete(credential);
        Ok(())
    }

    fn error(&self, error: BitwardenError) {
        self.on_error(error);
    }
}

impl PreparePasswordCredentialCallback for TimedCallback<PasswordCredentialResponse> {
    fn on_complete(&self, credential: PasswordCredentialResponse) {
        self.send(Ok(credential));
    }

    fn on_error(&self, error: BitwardenError) {
        self.send(Err(error));
    }
}

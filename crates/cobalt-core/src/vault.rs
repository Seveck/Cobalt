//! Private vault: AES-256-GCM encryption with a key derived from a master password via
//! Argon2id. The key lives only in RAM (zeroized on lock/drop) and is dropped automatically
//! after `auto_lock` of inactivity. Only a salt and an encrypted check value are persisted
//! (`~/.cobalt/vault.json`); the password is never stored.
//!
//! Also provides password-sealed blobs (`seal_with_password` / `open_with_password`) used by
//! encrypted `.cobalt-backup` files.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::error::{CobaltError, Result};

pub const VAULT_FILE: &str = "vault.json";
pub const MIN_PASSWORD_LEN: usize = 8;
const KEY_LEN: usize = 32;
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 12;
const CHECK_PLAINTEXT: &[u8] = b"cobalt-vault-check-v1";
const CHECK_AAD: &[u8] = b"cobalt-vault";
const SEAL_MAGIC: &[u8; 8] = b"CBSEAL1\0";

/// Argon2id cost parameters.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct KdfParams {
    /// Memory cost in KiB.
    pub m_cost: u32,
    pub t_cost: u32,
    pub p_cost: u32,
}

impl Default for KdfParams {
    /// 64 MiB, 3 passes, 1 lane (above OWASP minimums; ~0.2–0.5 s on a laptop).
    fn default() -> Self {
        Self {
            m_cost: 64 * 1024,
            t_cost: 3,
            p_cost: 1,
        }
    }
}

impl KdfParams {
    /// Cheap parameters for unit tests only.
    #[cfg(test)]
    pub const TEST: Self = Self {
        m_cost: 64,
        t_cost: 1,
        p_cost: 1,
    };

    fn validate(&self) -> Result<()> {
        // Refuse downgraded files: never accept less than 8 MiB / 1 pass outside tests.
        let min_m = if cfg!(test) { 8 } else { 8 * 1024 };
        if self.m_cost < min_m
            || self.t_cost < 1
            || self.p_cost < 1
            || self.m_cost > 4 * 1024 * 1024
        {
            return Err(CobaltError::Crypto(
                "unsupported key-derivation parameters".into(),
            ));
        }
        Ok(())
    }
}

fn derive_key(password: &str, salt: &[u8], params: KdfParams) -> Result<Zeroizing<[u8; KEY_LEN]>> {
    params.validate()?;
    let argon_params = Params::new(params.m_cost, params.t_cost, params.p_cost, Some(KEY_LEN))
        .map_err(|e| CobaltError::Crypto(format!("argon2 params: {e}")))?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, argon_params);
    let mut key = Zeroizing::new([0u8; KEY_LEN]);
    argon
        .hash_password_into(password.as_bytes(), salt, key.as_mut())
        .map_err(|e| CobaltError::Crypto(format!("argon2: {e}")))?;
    Ok(key)
}

fn random_bytes<const N: usize>() -> [u8; N] {
    let mut buf = [0u8; N];
    rand::fill(&mut buf[..]);
    buf
}

fn cipher(key: &[u8; KEY_LEN]) -> Result<Aes256Gcm> {
    Aes256Gcm::new_from_slice(key).map_err(|_| CobaltError::Crypto("invalid key length".into()))
}

fn encrypt_raw(key: &[u8; KEY_LEN], aad: &[u8], plaintext: &[u8]) -> Result<(Vec<u8>, Vec<u8>)> {
    let nonce_bytes = random_bytes::<NONCE_LEN>();
    let nonce = Nonce::try_from(&nonce_bytes[..])
        .map_err(|_| CobaltError::Crypto("invalid nonce length".into()))?;
    let ct = cipher(key)?
        .encrypt(
            &nonce,
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|_| CobaltError::Crypto("encryption failed".into()))?;
    Ok((ct, nonce_bytes.to_vec()))
}

fn decrypt_raw(
    key: &[u8; KEY_LEN],
    aad: &[u8],
    ciphertext: &[u8],
    nonce: &[u8],
) -> Result<Vec<u8>> {
    let nonce =
        Nonce::try_from(nonce).map_err(|_| CobaltError::Crypto("invalid nonce length".into()))?;
    cipher(key)?
        .decrypt(
            &nonce,
            Payload {
                msg: ciphertext,
                aad,
            },
        )
        .map_err(|_| CobaltError::Crypto("decryption failed (wrong key or tampered data)".into()))
}

/// Persisted vault metadata (no secret material).
#[derive(Debug, Clone, Serialize, Deserialize)]
struct VaultFile {
    version: u32,
    kdf: String,
    params: KdfParams,
    salt: String,
    check_nonce: String,
    check_ciphertext: String,
}

struct VaultState {
    key: Option<Zeroizing<[u8; KEY_LEN]>>,
    last_used: Instant,
    auto_lock: Duration,
}

pub struct Vault {
    file: PathBuf,
    params: KdfParams,
    state: Mutex<VaultState>,
}

impl Vault {
    /// Opens (does not create) the vault stored at `<home>/vault.json`.
    pub fn open(home: &Path, auto_lock_minutes: u32) -> Self {
        Self::open_with_params(
            home.join(VAULT_FILE),
            auto_lock_minutes,
            KdfParams::default(),
        )
    }

    pub fn open_with_params(file: PathBuf, auto_lock_minutes: u32, params: KdfParams) -> Self {
        Self {
            file,
            params,
            state: Mutex::new(VaultState {
                key: None,
                last_used: Instant::now(),
                auto_lock: minutes(auto_lock_minutes),
            }),
        }
    }

    fn state(&self) -> MutexGuard<'_, VaultState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn is_initialized(&self) -> bool {
        self.file.is_file()
    }

    /// `true` while unlocked and not idle for longer than the auto-lock delay.
    pub fn is_unlocked(&self) -> bool {
        let mut st = self.state();
        expire_if_idle(&mut st, Instant::now());
        st.key.is_some()
    }

    pub fn auto_lock_minutes(&self) -> u32 {
        u32::try_from(self.state().auto_lock.as_secs() / 60).unwrap_or(u32::MAX)
    }

    pub fn set_auto_lock_minutes(&self, m: u32) {
        self.state().auto_lock = minutes(m);
    }

    /// Creates the vault with a new master password and leaves it unlocked.
    /// CPU-heavy (Argon2id): call from a blocking context.
    pub fn setup(&self, password: &str) -> Result<()> {
        if self.is_initialized() {
            return Err(CobaltError::Conflict("vault is already initialized".into()));
        }
        if password.chars().count() < MIN_PASSWORD_LEN {
            return Err(CobaltError::InvalidInput(format!(
                "master password must have at least {MIN_PASSWORD_LEN} characters"
            )));
        }
        let salt = random_bytes::<SALT_LEN>();
        let key = derive_key(password, &salt, self.params)?;
        let (check_ct, check_nonce) = encrypt_raw(&key, CHECK_AAD, CHECK_PLAINTEXT)?;
        let file = VaultFile {
            version: 1,
            kdf: "argon2id".into(),
            params: self.params,
            salt: B64.encode(salt),
            check_nonce: B64.encode(check_nonce),
            check_ciphertext: B64.encode(check_ct),
        };
        write_atomic(&self.file, &serde_json::to_vec_pretty(&file)?)?;
        let mut st = self.state();
        st.key = Some(key);
        st.last_used = Instant::now();
        Ok(())
    }

    /// Verifies the password and keeps the derived key in RAM.
    /// CPU-heavy (Argon2id): call from a blocking context.
    pub fn unlock(&self, password: &str) -> Result<()> {
        let raw = std::fs::read(&self.file).map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => {
                CobaltError::NotFound("vault is not initialized".into())
            }
            _ => CobaltError::Io(e),
        })?;
        let file: VaultFile = serde_json::from_slice(&raw)?;
        if file.version != 1 || file.kdf != "argon2id" {
            return Err(CobaltError::Unsupported("vault file version".into()));
        }
        let decode = |s: &str| {
            B64.decode(s)
                .map_err(|_| CobaltError::Integrity("corrupt vault file".into()))
        };
        let key = derive_key(password, &decode(&file.salt)?, file.params)?;
        decrypt_raw(
            &key,
            CHECK_AAD,
            &decode(&file.check_ciphertext)?,
            &decode(&file.check_nonce)?,
        )
        .map_err(|_| CobaltError::Crypto("incorrect master password".into()))?;
        let mut st = self.state();
        st.key = Some(key);
        st.last_used = Instant::now();
        Ok(())
    }

    /// Drops (and zeroizes) the in-memory key.
    pub fn lock(&self) {
        self.state().key = None;
    }

    /// Locks the vault if it has been idle too long. Returns `true` if it locked now.
    pub fn tick(&self) -> bool {
        self.tick_at(Instant::now())
    }

    pub fn tick_at(&self, now: Instant) -> bool {
        let mut st = self.state();
        let was_unlocked = st.key.is_some();
        expire_if_idle(&mut st, now);
        was_unlocked && st.key.is_none()
    }

    /// Encrypts `plaintext` bound to `aad` (use the memory id). Returns `(ciphertext, nonce)`.
    pub fn encrypt(&self, aad: &[u8], plaintext: &[u8]) -> Result<(Vec<u8>, Vec<u8>)> {
        let mut st = self.state();
        expire_if_idle(&mut st, Instant::now());
        let key = st.key.as_ref().ok_or(CobaltError::VaultLocked)?;
        let out = encrypt_raw(key, aad, plaintext)?;
        st.last_used = Instant::now();
        Ok(out)
    }

    pub fn decrypt(&self, aad: &[u8], ciphertext: &[u8], nonce: &[u8]) -> Result<Vec<u8>> {
        let mut st = self.state();
        expire_if_idle(&mut st, Instant::now());
        let key = st.key.as_ref().ok_or(CobaltError::VaultLocked)?;
        let out = decrypt_raw(key, aad, ciphertext, nonce)?;
        st.last_used = Instant::now();
        Ok(out)
    }
}

fn minutes(m: u32) -> Duration {
    Duration::from_secs(u64::from(m.max(1)) * 60)
}

fn expire_if_idle(st: &mut VaultState, now: Instant) {
    if st.key.is_some() && now.saturating_duration_since(st.last_used) >= st.auto_lock {
        st.key = None;
    }
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

// ------------------------------------------------------------------ password-sealed blobs

/// Encrypts `plaintext` with a key derived from `password` (fresh salt + nonce).
/// Layout: `CBSEAL1\0 | m u32le | t u32le | p u32le | salt[16] | nonce[12] | ciphertext`.
/// The header is authenticated as AAD. CPU-heavy: call from a blocking context.
pub fn seal_with_password(password: &str, plaintext: &[u8]) -> Result<Vec<u8>> {
    seal_with_params(password, plaintext, KdfParams::default())
}

pub fn seal_with_params(password: &str, plaintext: &[u8], params: KdfParams) -> Result<Vec<u8>> {
    if password.is_empty() {
        return Err(CobaltError::InvalidInput(
            "password must not be empty".into(),
        ));
    }
    let salt = random_bytes::<SALT_LEN>();
    let key = derive_key(password, &salt, params)?;
    let nonce_bytes = random_bytes::<NONCE_LEN>();
    let mut header = Vec::with_capacity(8 + 12 + SALT_LEN + NONCE_LEN);
    header.extend_from_slice(SEAL_MAGIC);
    header.extend_from_slice(&params.m_cost.to_le_bytes());
    header.extend_from_slice(&params.t_cost.to_le_bytes());
    header.extend_from_slice(&params.p_cost.to_le_bytes());
    header.extend_from_slice(&salt);
    header.extend_from_slice(&nonce_bytes);
    let nonce = Nonce::try_from(&nonce_bytes[..])
        .map_err(|_| CobaltError::Crypto("invalid nonce length".into()))?;
    let ct = cipher(&key)?
        .encrypt(
            &nonce,
            Payload {
                msg: plaintext,
                aad: &header,
            },
        )
        .map_err(|_| CobaltError::Crypto("encryption failed".into()))?;
    header.extend_from_slice(&ct);
    Ok(header)
}

/// `true` if `data` starts with the sealed-blob magic.
pub fn is_sealed(data: &[u8]) -> bool {
    data.starts_with(SEAL_MAGIC)
}

pub fn open_with_password(password: &str, sealed: &[u8]) -> Result<Vec<u8>> {
    let header_len = 8 + 12 + SALT_LEN + NONCE_LEN;
    if sealed.len() < header_len + 16 || !is_sealed(sealed) {
        return Err(CobaltError::Integrity("not a Cobalt sealed payload".into()));
    }
    let u32_at = |i: usize| {
        let mut b = [0u8; 4];
        b.copy_from_slice(&sealed[i..i + 4]);
        u32::from_le_bytes(b)
    };
    let params = KdfParams {
        m_cost: u32_at(8),
        t_cost: u32_at(12),
        p_cost: u32_at(16),
    };
    let salt = &sealed[20..20 + SALT_LEN];
    let nonce = &sealed[20 + SALT_LEN..header_len];
    let key = derive_key(password, salt, params)?;
    decrypt_raw(&key, &sealed[..header_len], &sealed[header_len..], nonce)
        .map_err(|_| CobaltError::Crypto("incorrect password or corrupted payload".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_vault(dir: &Path) -> Vault {
        Vault::open_with_params(dir.join(VAULT_FILE), 10, KdfParams::TEST)
    }

    #[test]
    fn setup_unlock_encrypt_decrypt() {
        let dir = tempfile::tempdir().unwrap();
        let vault = test_vault(dir.path());
        assert!(!vault.is_initialized());
        assert!(matches!(
            vault.encrypt(b"id", b"x"),
            Err(CobaltError::VaultLocked)
        ));
        assert!(matches!(
            vault.setup("short"),
            Err(CobaltError::InvalidInput(_))
        ));
        vault.setup("correct horse battery").unwrap();
        assert!(vault.is_initialized() && vault.is_unlocked());
        assert!(matches!(
            vault.setup("another password"),
            Err(CobaltError::Conflict(_))
        ));

        let (ct, nonce) = vault
            .encrypt(b"memory-1", "secreto: clave del NAS".as_bytes())
            .unwrap();
        assert_eq!(nonce.len(), NONCE_LEN);
        assert_eq!(
            vault.decrypt(b"memory-1", &ct, &nonce).unwrap(),
            "secreto: clave del NAS".as_bytes()
        );
        // AAD binds the ciphertext to its memory id.
        assert!(vault.decrypt(b"memory-2", &ct, &nonce).is_err());

        vault.lock();
        assert!(matches!(
            vault.decrypt(b"memory-1", &ct, &nonce),
            Err(CobaltError::VaultLocked)
        ));

        // Fresh process: wrong then right password.
        let reopened = test_vault(dir.path());
        assert!(matches!(
            reopened.unlock("wrong password!"),
            Err(CobaltError::Crypto(_))
        ));
        reopened.unlock("correct horse battery").unwrap();
        assert_eq!(
            reopened.decrypt(b"memory-1", &ct, &nonce).unwrap(),
            "secreto: clave del NAS".as_bytes()
        );

        // No secret material on disk.
        let on_disk = std::fs::read_to_string(dir.path().join(VAULT_FILE)).unwrap();
        assert!(!on_disk.contains("correct horse"));
    }

    #[test]
    fn auto_lock_after_inactivity() {
        let dir = tempfile::tempdir().unwrap();
        let vault = test_vault(dir.path());
        vault.setup("correct horse battery").unwrap();
        vault.set_auto_lock_minutes(5);
        let now = Instant::now();
        assert!(!vault.tick_at(now + Duration::from_secs(60)));
        assert!(vault.tick_at(now + Duration::from_secs(5 * 60 + 1)));
        assert!(!vault.is_unlocked());
    }

    #[test]
    fn unlock_without_setup_is_not_found() {
        let dir = tempfile::tempdir().unwrap();
        assert!(matches!(
            test_vault(dir.path()).unlock("whatever123"),
            Err(CobaltError::NotFound(_))
        ));
    }

    #[test]
    fn sealed_blobs_roundtrip_and_detect_tampering() {
        let sealed = seal_with_params("backup-pass", b"brain dump", KdfParams::TEST).unwrap();
        assert!(is_sealed(&sealed));
        assert_eq!(
            open_with_password("backup-pass", &sealed).unwrap(),
            b"brain dump"
        );
        assert!(open_with_password("nope", &sealed).is_err());
        let mut tampered = sealed.clone();
        let last = tampered.len() - 1;
        tampered[last] ^= 0x01;
        assert!(open_with_password("backup-pass", &tampered).is_err());
        // Header (params) is authenticated too.
        let mut header_tampered = sealed;
        header_tampered[12] ^= 0x01;
        assert!(open_with_password("backup-pass", &header_tampered).is_err());
        assert!(open_with_password("x", b"garbage").is_err());
    }
}

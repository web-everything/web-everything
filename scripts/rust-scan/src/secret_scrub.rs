//! Rust port of `scripts/lib/secret-scrub.mjs`'s `scrubPublish` — the ONLY export `check-standards.mjs`'s
//! live gate calls (via `scanPublishSecrets`, `scripts/check-standards-rules.mjs`). The wider append-seam
//! `scrubReasons`/`isHighEntropyToken` detector is used only by `scripts/conveyor/learnings-drop.mjs`, a
//! different subsystem this item does not touch, so it is deliberately NOT ported — porting code
//! `check-standards.mjs` never calls would be risk with no corresponding win.
//!
//! `\w`/`\d` are spelled out as explicit ASCII classes throughout, same reasoning as `stdout_flush.rs`'s doc.

use rayon::prelude::*;
use regex::Regex;
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::OnceLock;

fn shannon_entropy(s: &str) -> f64 {
    let mut freq: HashMap<char, u32> = HashMap::new();
    let mut len = 0u32;
    for ch in s.chars() {
        *freq.entry(ch).or_insert(0) += 1;
        len += 1;
    }
    if len == 0 {
        return 0.0;
    }
    let mut h = 0.0f64;
    for &n in freq.values() {
        let p = n as f64 / len as f64;
        h -= p * p.log2();
    }
    h
}

fn char_classes(s: &str) -> u32 {
    let lower = s.bytes().any(|b| b.is_ascii_lowercase());
    let upper = s.bytes().any(|b| b.is_ascii_uppercase());
    let digit = s.bytes().any(|b| b.is_ascii_digit());
    lower as u32 + upper as u32 + digit as u32
}

/// Vowel ratio over ALPHABETIC chars only. `< 8` letters ⇒ 1.0 ("pronounceable, don't flag") — mirrors the
/// JS `letters < 8` early return exactly.
fn vowel_ratio(s: &str) -> f64 {
    let letters = s.chars().filter(|c| c.is_ascii_alphabetic()).count();
    if letters < 8 {
        return 1.0;
    }
    let vowels = s.chars().filter(|c| matches!(c.to_ascii_uppercase(), 'A' | 'E' | 'I' | 'O' | 'U')).count();
    vowels as f64 / letters as f64
}

struct Patterns {
    publish_secret: Vec<(Regex, &'static str)>,
    cred_label: Regex,
    blob_run: Regex,
    email: Regex,
    ipv4: Regex,
    ipv6: Regex,
    opaque_token_shape: Regex,
    pure_hex: Regex,
    segment_trim: Regex,
    ascii_alnum_only: Regex,
}

const BLOB_ENTROPY_MIN: f64 = 4.8;
const TOKEN_VOWEL_MAX: f64 = 0.20;

const SERVICE_LOCALS: &[&str] =
    &["git", "noreply", "no-reply", "postmaster", "hostmaster", "webmaster", "mailer-daemon", "abuse"];

fn patterns() -> &'static Patterns {
    static P: OnceLock<Patterns> = OnceLock::new();
    P.get_or_init(|| Patterns {
        // PUBLISH_SECRET_PATTERNS = SECRET_PATTERNS minus the two entropy-shaped ones (blob/hex), plus the
        // inline-credential-URL rule — see the JS module's `PUBLISH_SECRET_PATTERNS` construction.
        publish_secret: vec![
            (Regex::new(r"-----BEGIN [A-Z ]*(?:PRIVATE KEY|CERTIFICATE)").unwrap(), "PEM key/cert block"),
            (Regex::new(r"\b(?:sk|pk|rk)-[A-Za-z0-9]{16,}").unwrap(), "api-key-shaped token (sk-/pk-/rk-)"),
            (Regex::new(r"\bgh[posru]_[A-Za-z0-9]{16,}").unwrap(), "GitHub token (ghp_/gho_/…)"),
            (Regex::new(r"\bgithub_pat_[A-Za-z0-9_]{40,}").unwrap(), "GitHub fine-grained PAT (github_pat_…)"),
            (Regex::new(r"\bxox[baprs]-[A-Za-z0-9-]{10,}").unwrap(), "Slack token (xox…)"),
            (Regex::new(r"\bAKIA[0-9A-Z]{12,}").unwrap(), "AWS access key id (AKIA…)"),
            (Regex::new(r"\bAIza[0-9A-Za-z_-]{30,}").unwrap(), "Google API key (AIza…)"),
            (
                Regex::new(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}").unwrap(),
                "JWT (eyJ….….…)",
            ),
            (
                Regex::new(r"\b[a-z][a-z0-9+.-]*://[^\s/@]+:[^\s/@]+@").unwrap(),
                "URL with inline credentials (user:pass@host)",
            ),
        ],
        cred_label: Regex::new(
            r#"(?i)\b(?:password|passwd|secret|api[_-]?key|access[_-]?key|token|credential)s?\b\s*[:=]\s*(['"]?)([^\s'"]+)"#,
        )
        .unwrap(),
        blob_run: Regex::new(r"[A-Za-z0-9+/=_-]{40,}").unwrap(),
        email: Regex::new(r"\b([A-Za-z0-9._%+-]+)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b").unwrap(),
        ipv4: Regex::new(r"\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b").unwrap(),
        ipv6: Regex::new(r"\b(?:[0-9A-Fa-f]{1,4}:){3,}[0-9A-Fa-f]{1,4}\b").unwrap(),
        opaque_token_shape: Regex::new(r"^[A-Za-z0-9+=_]+$").unwrap(),
        pure_hex: Regex::new(r"^[0-9a-fA-F]+$").unwrap(),
        segment_trim: Regex::new(r"^[^A-Za-z0-9+=_]+|[^A-Za-z0-9+=_]+$").unwrap(),
        ascii_alnum_only: Regex::new(r"[\s/]+").unwrap(),
    })
}

fn is_opaque_publish_token(tok: &str) -> bool {
    let p = patterns();
    if tok.len() < 20 || tok.len() > 256 {
        return false;
    }
    if !p.opaque_token_shape.is_match(tok) {
        return false;
    }
    if p.pure_hex.is_match(tok) {
        return false;
    }
    if shannon_entropy(tok) < 3.0 {
        return false;
    }
    vowel_ratio(tok) < TOKEN_VOWEL_MAX
}

fn publish_segments(value: &str) -> Vec<String> {
    let p = patterns();
    let mut out = Vec::new();
    for raw in p.ascii_alnum_only.split(value) {
        let t = p.segment_trim.replace_all(raw, "");
        if !t.is_empty() {
            out.push(t.to_string());
        }
    }
    out
}

/// JS's `CRED_LABEL` ends with a backreference (`\1`) requiring the value be followed by the SAME quote
/// character that opened it (or nothing, when unquoted) — e.g. `password: "x"` matches, a mismatched
/// `password: "x'` does not. The `regex` crate has no backreference support, so the pattern below omits it
/// (matching a strict SUPERSET of JS's occurrences) and this function replicates `\1` manually: for each
/// candidate, if an opening quote was captured, require that exact character immediately after the value.
fn cred_label_reasons(value: &str) -> Vec<&'static str> {
    let p = patterns();
    for caps in p.cred_label.captures_iter(value) {
        let quote = caps.get(1).map(|m| m.as_str()).unwrap_or("");
        let value_match = caps.get(2).unwrap();
        if !quote.is_empty() && !value[value_match.end()..].starts_with(quote) {
            continue; // mismatched/missing closing quote — JS's \1 would refuse this occurrence
        }
        let v = value_match.as_str();
        if v.chars().count() >= 8 && char_classes(v) >= 2 {
            return vec!["inline credential (secret-shaped value)"];
        }
    }
    Vec::new()
}

fn email_reasons(value: &str) -> Vec<&'static str> {
    let p = patterns();
    for caps in p.email.captures_iter(value) {
        let local = caps.get(1).unwrap().as_str();
        let domain = caps.get(2).unwrap().as_str();
        if SERVICE_LOCALS.iter().any(|s| s.eq_ignore_ascii_case(local)) {
            continue;
        }
        if domain.contains("..") {
            continue;
        }
        let first_label = domain.split('.').next().unwrap_or("");
        if local.chars().count() < 2 || first_label.chars().count() < 2 {
            continue;
        }
        return vec!["email address (personal mailbox)"];
    }
    Vec::new()
}

fn ipv4_reasons(value: &str) -> Vec<&'static str> {
    let p = patterns();
    for caps in p.ipv4.captures_iter(value) {
        let o: Vec<i64> = (1..=4).map(|i| caps.get(i).unwrap().as_str().parse().unwrap_or(-1)).collect();
        if o.iter().any(|&n| n > 255) {
            continue; // a version string, not an address
        }
        let (a, b) = (o[0], o[1]);
        if a == 127 || a == 10 || a == 0 || a == 255 {
            continue;
        }
        if a == 192 && b == 168 {
            continue;
        }
        if a == 172 && (16..=31).contains(&b) {
            continue;
        }
        if a == 169 && b == 254 {
            continue;
        }
        return vec!["IPv4 address (public)"];
    }
    Vec::new()
}

/// Port of `scrubPublish`. Preserves JS's `[...new Set(reasons)]` de-dup — first-occurrence order, no dups.
pub fn scrub_publish(value: &str) -> Vec<String> {
    let p = patterns();
    let mut reasons: Vec<String> = Vec::new();
    let push_unique = |r: &mut Vec<String>, s: String| {
        if !r.iter().any(|x| x == &s) {
            r.push(s);
        }
    };

    for (re, why) in &p.publish_secret {
        if re.is_match(value) {
            push_unique(&mut reasons, why.to_string());
        }
    }
    for r in cred_label_reasons(value) {
        push_unique(&mut reasons, r.to_string());
    }
    for m in p.blob_run.find_iter(value) {
        if shannon_entropy(m.as_str()) >= BLOB_ENTROPY_MIN {
            push_unique(&mut reasons, "long opaque blob (≥40 chars, secret-level entropy)".to_string());
            break;
        }
    }
    for tok in publish_segments(value) {
        if is_opaque_publish_token(&tok) {
            push_unique(&mut reasons, "opaque token (unpronounceable ≥20-char key/secret)".to_string());
            break;
        }
    }
    for r in email_reasons(value) {
        push_unique(&mut reasons, r.to_string());
    }
    for r in ipv4_reasons(value) {
        push_unique(&mut reasons, r.to_string());
    }
    if p.ipv6.is_match(value) {
        push_unique(&mut reasons, "IPv6 address".to_string());
    }
    reasons
}

#[derive(Serialize)]
pub struct FileFinding {
    pub file: String,
    pub reasons: Vec<String>,
}

/// Port of `scanPublishSecrets`'s file-walk half (the pure detector is `scrub_publish` above). Mirrors
/// `check-standards.mjs`'s own loop EXACTLY: a FLAT (non-recursive) `.md` listing per top-level dir — NOT the
/// recursive walk `stdout_flush`'s scan uses. `readdirSync` in JS returns entries in the OS's raw directory
/// order (not sorted) unless the caller sorts; `check-standards.mjs`'s loop does not sort either, so this
/// does not sort — matching that, not "fixing" it into a different, non-matching order.
fn list_md_files(root: &Path, labels: &[&str]) -> Vec<(String, std::path::PathBuf)> {
    let mut files = Vec::new();
    for label in labels {
        let dir = root.join(label);
        let entries = match fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        let mut names: Vec<String> = entries
            .flatten()
            .filter_map(|e| {
                let name = e.file_name().to_string_lossy().to_string();
                if name.ends_with(".md") {
                    Some(name)
                } else {
                    None
                }
            })
            .collect();
        // `fs::read_dir` order is platform-dependent (unlike JS's raw `readdirSync`, which is also
        // OS-order); sort here so the OUTPUT is deterministic across platforms/runs even though the JS
        // caller's own order is not guaranteed either — a stricter, not weaker, contract for this port.
        names.sort();
        for name in names {
            let path = dir.join(&name);
            files.push((format!("{label}/{name}"), path));
        }
    }
    files
}

fn scan_one(rel: &str, path: &Path) -> Option<FileFinding> {
    let content = fs::read_to_string(path).ok()?;
    let reasons = scrub_publish(&content);
    if reasons.is_empty() {
        None
    } else {
        Some(FileFinding { file: rel.to_string(), reasons })
    }
}

/// Sequential reference — kept for the differential test against the JS port.
#[allow(dead_code)]
pub fn scan_publish_secrets(root: &Path, labels: &[&str]) -> Vec<FileFinding> {
    list_md_files(root, labels).into_iter().filter_map(|(rel, path)| scan_one(&rel, &path)).collect()
}

/// The `rayon`-parallel entry point the CLI calls (#3417) — same file list and per-file logic as
/// `scan_publish_secrets`, fanned out across whatever pool the caller installed.
pub fn scan_publish_secrets_parallel(root: &Path, labels: &[&str]) -> Vec<FileFinding> {
    list_md_files(root, labels).par_iter().filter_map(|(rel, path)| scan_one(rel, path)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_a_labeled_password() {
        let reasons = scrub_publish("password: hunter2Trombone");
        assert!(reasons.iter().any(|r| r.contains("inline credential")));
    }

    #[test]
    fn plain_word_value_passes() {
        assert_eq!(scrub_publish("the session token: often expires"), Vec::<String>::new());
    }

    #[test]
    fn github_pat_detected() {
        let reasons = scrub_publish("github_pat_11ABCDEFG0123456789012345678901234567890123456789012345");
        assert!(reasons.iter().any(|r| r.contains("GitHub fine-grained PAT")));
    }

    #[test]
    fn git_sha_hex_is_exempt() {
        // A 40-char lowercase-hex git SHA must NOT be flagged (the named exemption in the JS header).
        assert_eq!(scrub_publish("commit 2acf9e283e0eb72837964d9c58d049789a19dde3 landed"), Vec::<String>::new());
    }

    #[test]
    fn hyphenated_prose_is_not_flagged_as_opaque() {
        assert_eq!(scrub_publish("the UTF-16-code-unit boundary and JS-first-vs-CSS-first debate"), Vec::<String>::new());
    }

    #[test]
    fn service_account_email_passes() {
        assert_eq!(scrub_publish("origin is git@github.com:web-everything/web-everything.git"), Vec::<String>::new());
    }

    #[test]
    fn personal_email_is_flagged() {
        let reasons = scrub_publish("contact nic.g.gilbert@gmail.com for details");
        assert!(reasons.iter().any(|r| r.contains("personal mailbox")));
    }

    #[test]
    fn private_ipv4_passes_public_flagged() {
        assert_eq!(scrub_publish("bridge at 127.0.0.1:8080"), Vec::<String>::new());
        assert!(scrub_publish("server at 8.8.8.8").iter().any(|r| r.contains("public")));
    }

    #[test]
    fn dedups_reasons() {
        let reasons = scrub_publish("password: hunter2Trombone and secret: hunter2Trombone");
        let count = reasons.iter().filter(|r| r.contains("inline credential")).count();
        assert_eq!(count, 1);
    }

    #[test]
    fn quoted_credential_with_matching_close_is_flagged() {
        let reasons = scrub_publish(r#"password: "hunter2Trombone""#);
        assert!(reasons.iter().any(|r| r.contains("inline credential")));
    }

    #[test]
    fn quoted_credential_with_mismatched_close_is_not_flagged_by_this_rule() {
        // Manual \1 replication: an opening `"` must be followed by `"`, not `'` — mirrors JS's backreference.
        let reasons = scrub_publish("password: \"hunter2Trombone'");
        assert!(!reasons.iter().any(|r| r.contains("inline credential")));
    }
}

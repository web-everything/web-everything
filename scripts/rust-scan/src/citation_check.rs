//! Rust port of `scripts/lib/citation-check.mjs`'s four LOCUS-shaped gates (#3417/#2821), matching
//! `check-standards.mjs`'s "6f-ii CITATION-VERIFICATION gate family" section exactly:
//!   - anchor-authority (gate 10): `find_anchor_ruling_mismatches`
//!   - dangling loci (gate 5): `find_dangling_loci`
//!   - out-of-scope hash slugs (gate 3): `find_out_of_scope_hash_slugs`
//!   - dangling memory hash slugs (gate 3b): `find_dangling_memory_hash_slugs`
//!
//! DELIBERATELY NOT PORTED: the PROVENANCE gate (`findUnresolvedIdentifiers` and its supporting
//! `buildIdentifierIndex`/`isIndexableSourcePath`/`stripSourceComments`). It is architecturally separate —
//! its `addedLines` input comes from a live `git diff`/merge-base computation that lives in
//! `check-standards.mjs` itself, not citation-check.mjs — and porting it would mean replicating real git-diff
//! parsing in Rust, a materially larger scope than "port citation-check". Tracked as its own follow-up, not
//! bundled into this item's four gates.
//!
//! `fancy_regex` is used for exactly one pattern (`ANCHOR_SHAPE_A`, which needs a negative lookbehind the
//! plain `regex` crate cannot express) — same reasoning as `locus_prefix.rs`. `\w`/`\d` are spelled out as
//! explicit ASCII classes elsewhere, matching every other port's convention.

use crate::backlog_meta::{is_hash, load_backlog_items, BacklogItem};
use fancy_regex::Regex as FancyRegex;
use rayon::prelude::*;
use regex::Regex;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;
use std::sync::{Mutex, OnceLock};

use crate::locus_prefix::locus_prefix_re_source;

fn escape_regex(s: &str) -> String {
    regex::escape(s)
}

// ── gate 10: anchor-authority ───────────────────────────────────────────────────────────────────────────

/// Port of `buildAnchorOwners`. `doc` defaults to `docs/agent/platform-decisions.md` at the call site.
pub fn build_anchor_owners(items: &[BacklogItem], doc: &str) -> HashMap<String, Vec<String>> {
    let re = Regex::new(&format!(r"{}#([a-z0-9][a-z0-9-]*)", escape_regex(doc))).unwrap();
    let mut owners: HashMap<String, Vec<String>> = HashMap::new();
    for it in items {
        for field in [&it.codified_in, &it.graduated_to].into_iter().flatten() {
            if let Some(caps) = re.captures(field) {
                let anchor = caps.get(1).unwrap().as_str().to_string();
                let set = owners.entry(anchor).or_default();
                if !set.contains(&it.num) {
                    set.push(it.num.clone());
                }
            }
        }
    }
    owners
}

#[derive(Serialize)]
pub struct AnchorMismatch {
    pub anchor: String,
    #[serde(rename = "citedNum")]
    pub cited_num: String,
    pub owners: Vec<String>,
    pub shape: &'static str,
    pub context: String,
}

/// Byte-offset → char-count context window, safely (byte slicing on arbitrary offsets would panic on a
/// multi-byte UTF-8 boundary; this corpus's prose routinely carries em dashes and curly quotes). `idx` is
/// always a regex match start, which is always a valid char boundary, so `[..idx].chars().count()` is exact.
fn context_around(flat: &str, byte_idx: usize, before: usize, after: usize) -> String {
    let chars: Vec<char> = flat.chars().collect();
    let char_idx = flat[..byte_idx].chars().count();
    let start = char_idx.saturating_sub(before);
    let end = (char_idx + after).min(chars.len());
    chars[start..end].iter().collect::<String>().trim().to_string()
}

/// Port of `findAnchorRulingMismatches`.
pub fn find_anchor_ruling_mismatches(text: &str, anchor_owners: &HashMap<String, Vec<String>>) -> Vec<AnchorMismatch> {
    let mut findings = Vec::new();
    if text.is_empty() || anchor_owners.is_empty() {
        return findings;
    }
    let ws_re = Regex::new(r"\s+").unwrap();
    let flat = ws_re.replace_all(text, " ").to_string();

    let mut anchors: Vec<&String> = anchor_owners.keys().collect();
    anchors.sort_by(|a, b| b.len().cmp(&a.len())); // longest first, so a shorter anchor can't shadow a longer one
    let anchor_alt = anchors.iter().map(|a| escape_regex(a)).collect::<Vec<_>>().join("|");
    if anchor_alt.is_empty() {
        return findings;
    }

    let record = |findings: &mut Vec<AnchorMismatch>, anchor: &str, cited_num: &str, shape: &'static str, idx: usize| {
        let Some(owner_set) = anchor_owners.get(anchor) else { return };
        if owner_set.is_empty() || owner_set.iter().any(|o| o == cited_num) {
            return;
        }
        let mut owners_sorted = owner_set.clone();
        owners_sorted.sort();
        findings.push(AnchorMismatch {
            anchor: anchor.to_string(),
            cited_num: cited_num.to_string(),
            owners: owners_sorted,
            shape,
            context: context_around(&flat, idx, 30, 80),
        });
    };

    // Shape A: `#anchor (#NNN, …)` / `](#anchor) (#NNN)` — the negative lookbehind rules out `{#anchor}`
    // (a heading DEFINITION, never a citation).
    let shape_a = FancyRegex::new(&format!(
        r#"(?:\]\(#|(?<!\{{)#)({anchor_alt})[)`'"]*\s*\(\s*#([0-9]{{3,5}})\b[`'"]*\s*[,)]"#
    ))
    .unwrap();
    let mut pos = 0usize;
    while pos <= flat.len() {
        let Ok(Some(m)) = shape_a.captures_from_pos(&flat, pos) else { break };
        let whole = m.get(0).unwrap();
        let anchor = m.get(1).unwrap().as_str();
        let cited_num = m.get(2).unwrap().as_str();
        record(&mut findings, anchor, cited_num, "A", whole.start());
        pos = whole.end().max(pos + 1);
    }

    // Shape B: a single parenthetical group holding the anchor and a number as comma-adjacent tokens, in
    // either order.
    let paren_group = Regex::new(r"\(([^()]*)\)").unwrap();
    let anchor_then_num = Regex::new(&format!(r#"#({anchor_alt})[`'"]*\s*,\s*#([0-9]{{3,5}})\b"#)).unwrap();
    let num_then_anchor = Regex::new(&format!(r#"#([0-9]{{3,5}})\b[`'"]*\s*,\s*[`'"]*#({anchor_alt})\b"#)).unwrap();
    for pm in paren_group.captures_iter(&flat) {
        let whole = pm.get(0).unwrap();
        let inner = pm.get(1).unwrap().as_str();
        if let Some(am) = anchor_then_num.captures(inner) {
            record(&mut findings, am.get(1).unwrap().as_str(), am.get(2).unwrap().as_str(), "B", whole.start());
            continue;
        }
        if let Some(nm) = num_then_anchor.captures(inner) {
            record(&mut findings, nm.get(2).unwrap().as_str(), nm.get(1).unwrap().as_str(), "B", whole.start());
        }
    }

    findings
}

// ── gate 5: dangling loci ───────────────────────────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct DanglingLocus {
    pub locus: String,
    pub path: String,
    pub line: u64,
    pub reason: &'static str,
}

fn locus_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(&format!(r"\b({}):([A-Za-z0-9._\-/]+/[A-Za-z0-9._\-]+):([0-9]+)(?:-([0-9]+))?\b", locus_prefix_re_source())).unwrap()
    })
}

fn is_in_repo_path(p: &str) -> bool {
    !p.is_empty() && !p.starts_with('/') && !p.split('/').any(|seg| seg == "..")
}

/// Port of `findDanglingLoci`. `file_exists`/`line_count` are injected (I/O-free core, matching the JS
/// module's own design) — `line_count` returns `None` for an unreadable file (skip, don't guess).
pub fn find_dangling_loci(
    text: &str,
    file_exists: impl Fn(&str) -> bool,
    mut line_count: impl FnMut(&str) -> Option<u64>,
) -> Vec<DanglingLocus> {
    let mut findings = Vec::new();
    if text.is_empty() {
        return findings;
    }
    let mut seen = HashSet::new();
    for caps in locus_re().captures_iter(text) {
        let prefix = caps.get(1).unwrap().as_str();
        let path = caps.get(2).unwrap().as_str();
        let start_str = caps.get(3).unwrap().as_str();
        let end_str = caps.get(4).map(|m| m.as_str());

        if prefix != "we" && prefix != "webeverything" {
            continue;
        }
        if !is_in_repo_path(path) {
            continue;
        }
        let locus = match end_str {
            Some(e) => format!("{prefix}:{path}:{start_str}-{e}"),
            None => format!("{prefix}:{path}:{start_str}"),
        };
        if !seen.insert(locus.clone()) {
            continue;
        }
        let start: u64 = start_str.parse().unwrap_or(0);
        if !file_exists(path) {
            findings.push(DanglingLocus { locus, path: path.to_string(), line: start, reason: "missing-file" });
            continue;
        }
        let Some(count) = line_count(path) else { continue };
        let hi: u64 = end_str.map(|e| e.parse().unwrap_or(0)).unwrap_or(start);
        if start < 1 || hi > count {
            findings.push(DanglingLocus { locus, path: path.to_string(), line: hi, reason: "line-out-of-range" });
        }
    }
    findings
}

/// Port of `countSourceLines`.
pub fn count_source_lines(text: &str) -> u64 {
    if text.is_empty() {
        return 0;
    }
    let n = text.split('\n').count() as u64;
    if text.ends_with('\n') { n - 1 } else { n }
}

// ── gates 3 / 3b: hash-slug scope ───────────────────────────────────────────────────────────────────────

const HASH_SLUG_OUT_OF_SCOPE_DIRS: &[&str] =
    &["reports/", "src/_data/researchTopics/", "src/_includes/research-descriptions/"];

fn hash_ref_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"#(x[0-9a-z]{6})\b").unwrap())
}
fn file_link_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"\b(x[0-9a-z]{6})-[a-z0-9-]+\.md\b").unwrap())
}

#[derive(Serialize)]
pub struct HashSlugFinding {
    pub slug: String,
    pub form: &'static str,
}

/// Port of `findOutOfScopeHashSlugs`. Deduped per distinct slug, first-form-seen (hash-ref scanned before
/// file-link), matching the JS `Map` insertion-order semantics exactly.
pub fn find_out_of_scope_hash_slugs(text: &str, rel_path: &str) -> Vec<HashSlugFinding> {
    let mut findings = Vec::new();
    if text.is_empty() || !HASH_SLUG_OUT_OF_SCOPE_DIRS.iter().any(|d| rel_path.starts_with(d)) {
        return findings;
    }
    let mut seen: HashMap<String, &'static str> = HashMap::new();
    let mut order: Vec<String> = Vec::new();
    for m in hash_ref_re().captures_iter(text) {
        let slug = m.get(1).unwrap().as_str().to_string();
        if !seen.contains_key(&slug) {
            seen.insert(slug.clone(), "hash-ref");
            order.push(slug);
        }
    }
    for m in file_link_re().captures_iter(text) {
        let slug = m.get(1).unwrap().as_str().to_string();
        if !seen.contains_key(&slug) {
            seen.insert(slug.clone(), "file-link");
            order.push(slug);
        }
    }
    for slug in order {
        let form = seen[&slug];
        findings.push(HashSlugFinding { slug, form });
    }
    findings
}

#[derive(Serialize)]
pub struct MemoryHashFinding {
    pub slug: String,
    pub form: &'static str,
    pub reason: &'static str,
}

/// Port of `findDanglingMemoryHashSlugs`.
pub fn find_dangling_memory_hash_slugs(
    text: &str,
    pending_hashes: &HashSet<String>,
    born_as_hashes: &HashSet<String>,
) -> Vec<MemoryHashFinding> {
    let mut findings = Vec::new();
    if text.is_empty() {
        return findings;
    }
    let classify = |slug: &str| -> Option<&'static str> {
        if pending_hashes.contains(slug) {
            None
        } else if born_as_hashes.contains(slug) {
            Some("dead-landed")
        } else {
            Some("unresolved")
        }
    };
    for m in hash_ref_re().captures_iter(text) {
        let slug = m.get(1).unwrap().as_str();
        if let Some(reason) = classify(slug) {
            findings.push(MemoryHashFinding { slug: slug.to_string(), form: "hash-ref", reason });
        }
    }
    for m in file_link_re().captures_iter(text) {
        let slug = m.get(1).unwrap().as_str();
        if let Some(reason) = classify(slug) {
            findings.push(MemoryHashFinding { slug: slug.to_string(), form: "file-link", reason });
        }
    }
    findings
}

#[allow(dead_code)]
pub fn is_hash_slug(s: &str) -> bool {
    is_hash(s)
}

// ── orchestration: one combined finding stream, matching check-standards.mjs's per-file scan loop ────────

/// One tagged finding across all four gates — a single JSON array lets the CLI walk each of the six scanned
/// directories ONCE per file (matching JS's own combined `scanFile` loop) instead of four separate
/// subcommands each re-walking and re-reading the same corpus.
#[derive(Serialize)]
#[serde(tag = "kind")]
pub enum CitationFinding {
    #[serde(rename = "anchor")]
    Anchor {
        file: String,
        anchor: String,
        #[serde(rename = "citedNum")]
        cited_num: String,
        owners: Vec<String>,
        shape: &'static str,
        context: String,
    },
    #[serde(rename = "locus")]
    Locus { file: String, locus: String, path: String, line: u64, reason: &'static str },
    #[serde(rename = "hashslug")]
    HashSlug { file: String, slug: String, form: &'static str },
    #[serde(rename = "memoryhash")]
    MemoryHash { file: String, slug: String, form: &'static str, reason: &'static str },
}

/// The six directories + extensions check-standards.mjs scans, in its own order (order doesn't affect
/// findings, since each file's result is independent and the output isn't itself ordered by scan sequence
/// beyond what `list_scan_files`'s own per-directory sort already fixes deterministically).
const SCAN_DIRS: &[(&str, &[&str])] = &[
    ("backlog/", &[".md"]),
    ("docs/agent/", &[".md"]),
    ("agent-memory-src/", &[".md"]),
    ("reports/", &[".md"]),
    ("src/_data/researchTopics/", &[".json"]),
    ("src/_includes/research-descriptions/", &[".njk"]),
];

fn list_scan_files(root: &Path) -> Vec<(String, std::path::PathBuf)> {
    let mut files = Vec::new();
    for (dir, exts) in SCAN_DIRS {
        let abs = root.join(dir);
        let entries = match fs::read_dir(&abs) {
            Ok(e) => e,
            Err(_) => continue,
        };
        let mut names: Vec<String> = entries
            .flatten()
            .filter_map(|e| {
                let name = e.file_name().to_string_lossy().to_string();
                if exts.iter().any(|ext| name.ends_with(ext)) { Some(name) } else { None }
            })
            .collect();
        names.sort();
        for name in names {
            files.push((format!("{dir}{name}"), abs.join(&name)));
        }
    }
    files
}

/// A memoized, thread-safe line counter for `find_dangling_loci`'s `line_count` — mirrors #2863's JS fix
/// (measured 145x/40x redundant re-reads of popular cited files without it). Shared across the rayon pool
/// via `Arc` at the call site; a `Mutex` is enough here since each lookup is a fast local-file read, not a
/// slow operation worth releasing the lock around.
pub struct LineCountCache {
    root: std::path::PathBuf,
    cache: Mutex<HashMap<String, Option<u64>>>,
}

impl LineCountCache {
    pub fn new(root: &Path) -> Self {
        Self { root: root.to_path_buf(), cache: Mutex::new(HashMap::new()) }
    }

    fn get(&self, rel_path: &str) -> Option<u64> {
        if let Some(v) = self.cache.lock().unwrap().get(rel_path) {
            return *v;
        }
        let count = fs::read_to_string(self.root.join(rel_path)).ok().map(|s| count_source_lines(&s));
        self.cache.lock().unwrap().insert(rel_path.to_string(), count);
        count
    }
}

fn scan_one_file(
    root: &Path,
    rel: &str,
    content: &str,
    anchor_owners: &HashMap<String, Vec<String>>,
    pending_hashes: &HashSet<String>,
    born_as_hashes: &HashSet<String>,
    line_cache: &LineCountCache,
) -> Vec<CitationFinding> {
    let mut out = Vec::new();

    for f in find_anchor_ruling_mismatches(content, anchor_owners) {
        out.push(CitationFinding::Anchor {
            file: rel.to_string(),
            anchor: f.anchor,
            cited_num: f.cited_num,
            owners: f.owners,
            shape: f.shape,
            context: f.context,
        });
    }

    let file_exists = |p: &str| root.join(p).exists();
    for f in find_dangling_loci(content, file_exists, |p| line_cache.get(p)) {
        out.push(CitationFinding::Locus { file: rel.to_string(), locus: f.locus, path: f.path, line: f.line, reason: f.reason });
    }

    for f in find_out_of_scope_hash_slugs(content, rel) {
        out.push(CitationFinding::HashSlug { file: rel.to_string(), slug: f.slug, form: f.form });
    }

    if rel.starts_with("agent-memory-src/") {
        for f in find_dangling_memory_hash_slugs(content, pending_hashes, born_as_hashes) {
            out.push(CitationFinding::MemoryHash { file: rel.to_string(), slug: f.slug, form: f.form, reason: f.reason });
        }
    }

    out
}

/// Sequential reference — kept for the differential test against the JS port.
#[allow(dead_code)]
pub fn scan_citations(root: &Path) -> Vec<CitationFinding> {
    let items = load_backlog_items(root);
    let anchor_owners = build_anchor_owners(&items, "docs/agent/platform-decisions.md");
    let pending_hashes: HashSet<String> = items.iter().filter(|it| is_hash(&it.num)).map(|it| it.num.clone()).collect();
    let born_as_hashes: HashSet<String> = items
        .iter()
        .filter_map(|it| it.born_as.as_ref())
        .filter(|h| is_hash(h))
        .cloned()
        .collect();
    let line_cache = LineCountCache::new(root);

    list_scan_files(root)
        .into_iter()
        .filter_map(|(rel, path)| {
            let content = fs::read_to_string(&path).ok()?;
            Some(scan_one_file(root, &rel, &content, &anchor_owners, &pending_hashes, &born_as_hashes, &line_cache))
        })
        .flatten()
        .collect()
}

/// The `rayon`-parallel entry point the CLI calls (#3417). Backlog metadata (anchor owners, pending/born-as
/// hash sets) is built ONCE up front (cheap — a few thousand small files, negligible next to the per-file
/// scan below) and shared read-only across the pool; the line-count cache is the one piece of shared
/// mutable state, guarded by its own `Mutex` (see `LineCountCache`).
pub fn scan_citations_parallel(root: &Path) -> Vec<CitationFinding> {
    let items = load_backlog_items(root);
    let anchor_owners = build_anchor_owners(&items, "docs/agent/platform-decisions.md");
    let pending_hashes: HashSet<String> = items.iter().filter(|it| is_hash(&it.num)).map(|it| it.num.clone()).collect();
    let born_as_hashes: HashSet<String> = items
        .iter()
        .filter_map(|it| it.born_as.as_ref())
        .filter(|h| is_hash(h))
        .cloned()
        .collect();
    let line_cache = LineCountCache::new(root);

    list_scan_files(root)
        .par_iter()
        .filter_map(|(rel, path)| {
            let content = fs::read_to_string(path).ok()?;
            Some(scan_one_file(root, rel, &content, &anchor_owners, &pending_hashes, &born_as_hashes, &line_cache))
        })
        .flatten()
        .collect()
}

#[cfg(test)]
mod tests {
    #[test]
    fn every_registered_prefix_is_parsed_and_resolved_in_its_own_repo() {
        for prefix in crate::locus_prefix::LOCUS_PREFIX_NAMES {
            let text = format!("Fix {prefix}:scripts/check-cards.mjs:12");
            assert_eq!(super::locus_re().captures(&text).unwrap().get(1).unwrap().as_str(), *prefix);
            let local = *prefix == "we" || *prefix == "webeverything";
            let findings = super::find_dangling_loci(&text, |_| {
                assert!(local, "cross-repo citations must not read local files");
                false
            }, |_| panic!("missing files have no line count"));
            assert_eq!(findings.len(), usize::from(local));
        }
    }

    use super::*;
    use crate::backlog_meta::BacklogItem;
    use std::fs;

    fn item(num: &str, codified_in: Option<&str>, graduated_to: Option<&str>, born_as: Option<&str>) -> BacklogItem {
        BacklogItem {
            num: num.to_string(),
            codified_in: codified_in.map(String::from),
            graduated_to: graduated_to.map(String::from),
            born_as: born_as.map(String::from),
        }
    }

    // ── gate 10: anchor-authority ──────────────────────────────────────────────────────────────────────

    #[test]
    fn anchor_owner_via_codified_in() {
        let items = vec![item("042", Some("docs/agent/platform-decisions.md#some-rule"), None, None)];
        let owners = build_anchor_owners(&items, "docs/agent/platform-decisions.md");
        assert_eq!(owners.get("some-rule"), Some(&vec!["042".to_string()]));
    }

    #[test]
    fn anchor_owner_via_graduated_to() {
        let items = vec![item("100", None, Some("docs/agent/platform-decisions.md#other-rule"), None)];
        let owners = build_anchor_owners(&items, "docs/agent/platform-decisions.md");
        assert_eq!(owners.get("other-rule"), Some(&vec!["100".to_string()]));
    }

    #[test]
    fn anchor_is_multi_owner_the_union_of_both_fields_across_items() {
        let items = vec![
            item("042", Some("docs/agent/platform-decisions.md#shared"), None, None),
            item("100", None, Some("docs/agent/platform-decisions.md#shared"), None),
        ];
        let owners = build_anchor_owners(&items, "docs/agent/platform-decisions.md");
        let mut got = owners.get("shared").unwrap().clone();
        got.sort();
        assert_eq!(got, vec!["042".to_string(), "100".to_string()]);
    }

    #[test]
    fn shape_a_wrong_attribution_flagged_correct_attribution_passes() {
        let mut owners = HashMap::new();
        owners.insert("some-rule".to_string(), vec!["042".to_string()]);

        let bad = find_anchor_ruling_mismatches("Per #some-rule (#999, elsewhere) this must hold.", &owners);
        assert_eq!(bad.len(), 1);
        assert_eq!(bad[0].anchor, "some-rule");
        assert_eq!(bad[0].cited_num, "999");
        assert_eq!(bad[0].shape, "A");

        let good = find_anchor_ruling_mismatches("Per #some-rule (#042, correct) this holds.", &owners);
        assert!(good.is_empty());
    }

    #[test]
    fn shape_b_comma_adjacent_paren_group_either_order() {
        let mut owners = HashMap::new();
        owners.insert("other-rule".to_string(), vec!["100".to_string()]);

        let a = find_anchor_ruling_mismatches("See (#999, #other-rule) here.", &owners);
        assert_eq!(a.len(), 1);
        assert_eq!(a[0].shape, "B");

        let b = find_anchor_ruling_mismatches("See (#other-rule, #999) here.", &owners);
        assert_eq!(b.len(), 1);
        assert_eq!(b[0].shape, "B");
    }

    #[test]
    fn heading_definition_form_is_never_a_citation() {
        // `{#anchor}` is a heading-definition marker, not a citation — the negative lookbehind's whole job.
        let mut owners = HashMap::new();
        owners.insert("some-rule".to_string(), vec!["042".to_string()]);
        let findings = find_anchor_ruling_mismatches("## Some heading {#some-rule} (#999, elsewhere)", &owners);
        assert!(findings.is_empty());
    }

    #[test]
    fn incidental_number_in_prose_beside_the_anchor_is_not_an_attribution() {
        let mut owners = HashMap::new();
        owners.insert("some-rule".to_string(), vec!["042".to_string()]);
        // No comma directly between the anchor and the number — shape B requires comma-adjacency.
        let findings = find_anchor_ruling_mismatches("(#999 introduced the check enforced by #some-rule)", &owners);
        assert!(findings.is_empty());
    }

    // ── gate 5: dangling loci ──────────────────────────────────────────────────────────────────────────

    #[test]
    fn missing_file_flagged() {
        let findings = find_dangling_loci("See we:scripts/nope.mjs:10 for details.", |_| false, |_| None);
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].reason, "missing-file");
    }

    #[test]
    fn line_out_of_range_flagged_in_range_passes() {
        let out = find_dangling_loci("See we:scripts/x.mjs:100 here.", |_| true, |_| Some(50));
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].reason, "line-out-of-range");

        let ok = find_dangling_loci("See we:scripts/x.mjs:10 here.", |_| true, |_| Some(50));
        assert!(ok.is_empty());
    }

    #[test]
    fn cross_repo_loci_never_checked() {
        let findings = find_dangling_loci("See fui:blocks/x.ts:10 here.", |_| false, |_| None);
        assert!(findings.is_empty());
    }

    #[test]
    fn path_traversal_never_reaches_fs_readers() {
        let findings = find_dangling_loci("See we:../../../etc/passwd:1 here.", |_| panic!("must not be called"), |_| panic!("must not be called"));
        assert!(findings.is_empty());
    }

    #[test]
    fn duplicate_loci_in_one_file_deduped() {
        let findings = find_dangling_loci("we:scripts/x.mjs:10 and again we:scripts/x.mjs:10", |_| false, |_| None);
        assert_eq!(findings.len(), 1);
    }

    #[test]
    fn count_source_lines_trailing_newline_not_overcounted() {
        assert_eq!(count_source_lines("a\nb\nc\n"), 3);
        assert_eq!(count_source_lines("a\nb\nc"), 3);
        assert_eq!(count_source_lines(""), 0);
    }

    // ── gates 3 / 3b: hash-slug scope ──────────────────────────────────────────────────────────────────

    #[test]
    fn out_of_scope_dir_flagged_in_scope_dir_passes() {
        let out = find_out_of_scope_hash_slugs("Filed as #xoutscp earlier.", "reports/r.md");
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].slug, "xoutscp");

        let ok = find_out_of_scope_hash_slugs("Filed as #xinscop earlier.", "backlog/x.md");
        assert!(ok.is_empty());
    }

    #[test]
    fn out_of_scope_dedups_per_slug_first_form_wins() {
        let findings = find_out_of_scope_hash_slugs("#xdupe01 cited, then xdupe01-slug.md linked, then #xdupe01 again.", "reports/r.md");
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].form, "hash-ref"); // hash-ref scanned before file-link
    }

    #[test]
    fn memory_hash_pending_passes_dead_landed_and_unresolved_flagged() {
        let pending: HashSet<String> = ["xpend01".to_string()].into_iter().collect();
        let born_as: HashSet<String> = ["xland01".to_string()].into_iter().collect();

        let pending_ok = find_dangling_memory_hash_slugs("#xpend01 still in flight", &pending, &born_as);
        assert!(pending_ok.is_empty());

        let dead = find_dangling_memory_hash_slugs("#xland01 already landed", &pending, &born_as);
        assert_eq!(dead.len(), 1);
        assert_eq!(dead[0].reason, "dead-landed");

        let unresolved = find_dangling_memory_hash_slugs("#xnowhr1 never existed", &pending, &born_as);
        assert_eq!(unresolved.len(), 1);
        assert_eq!(unresolved[0].reason, "unresolved");
    }

    // ── orchestration: sequential vs parallel, and a full multi-gate fixture ──────────────────────────

    #[test]
    fn sequential_and_parallel_scans_agree_on_a_real_multi_file_tree() {
        let dir = std::env::temp_dir().join(format!("we-scan-citation-test-{}", std::process::id()));
        let backlog = dir.join("backlog");
        let memory = dir.join("agent-memory-src");
        fs::create_dir_all(&backlog).unwrap();
        fs::create_dir_all(&memory).unwrap();
        fs::write(backlog.join("042-a.md"), "---\ncodifiedIn: \"docs/agent/platform-decisions.md#r1\"\n---\nbody\n").unwrap();
        fs::write(backlog.join("300-b.md"), "---\n---\nPer #r1 (#999, wrong) here.\n").unwrap();
        fs::write(memory.join("mem.md"), "---\n---\n#xnowhr1 unresolved here.\n").unwrap();

        let seq = scan_citations(&dir);
        let par = scan_citations_parallel(&dir);
        fs::remove_dir_all(&dir).ok();

        let norm = |v: Vec<CitationFinding>| -> Vec<String> {
            let mut s: Vec<String> = v.iter().map(|f| serde_json::to_string(f).unwrap()).collect();
            s.sort();
            s
        };
        let (sn, pn) = (norm(seq), norm(par));
        assert!(!sn.is_empty());
        assert_eq!(sn, pn);
    }
}

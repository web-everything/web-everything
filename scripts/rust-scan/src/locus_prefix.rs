//! Rust port of `scripts/check-standards-rules.mjs`'s `scanRepoLocusPrefixes` (#3417/#884). `\w`/`\d` are
//! spelled out as explicit ASCII classes throughout — same reasoning as `stdout_flush.rs`'s module doc (the
//! `regex` crate's `unicode(false)` mode breaks negated classes over UTF-8 text; JS's `\w`/`\d` are ASCII-only
//! without the `u` flag anyway, so this is exact parity, not an approximation).
//!
//! `PATHLIKE_RE` carries a negative lookahead (`(?![a-z])`, rejecting e.g. `.json` matching inside a
//! `.jsonl`-shaped token) that the plain `regex` crate cannot express at all. Approximating it by matching
//! broader then rejecting after the fact is fragile — JS's lookahead is evaluated AS PART OF the match
//! attempt, so a rejection there lets the engine retry from a different position within what would
//! otherwise have been consumed, which a two-pass "match wide, then narrow" approximation cannot reliably
//! reproduce. Using `fancy_regex` (a backtracking engine that supports lookaround) for this ONE pattern is
//! the honest fix, not a workaround.

use fancy_regex::Regex as FancyRegex;
use rayon::prelude::*;
use regex::Regex;
use serde::Serialize;
use std::fs;
use std::path::Path;
use std::sync::OnceLock;

// Mirror of citation-check.mjs; the JS/Rust parity test checks the complete vocabulary.
pub const LOCUS_PREFIX_NAMES: &[&str] = &[
    "we", "fui", "plateau", "longshore", "webeverything", "frontierui", "plateau-app",
];

pub fn locus_prefix_re_source() -> String {
    LOCUS_PREFIX_NAMES.iter().map(|prefix| regex::escape(prefix)).collect::<Vec<_>>().join("|")
}

struct Patterns {
    fenced: Regex,
    pathlike: FancyRegex,
    locus_marker: Regex,
    exempt_field: Regex,
    product_js: Regex,
    type_fragment: Regex,
    md_link_target: Regex,
    at_scope: Regex,
    url_prefix: Regex,
    glob_star: Regex,
}

fn patterns() -> &'static Patterns {
    static P: OnceLock<Patterns> = OnceLock::new();
    P.get_or_init(|| Patterns {
        // (?s) makes `.` match newlines too — JS's `[\s\S]*?` over the WHOLE content, non-greedy.
        fenced: Regex::new(r"(?s)```.*?```").unwrap(),
        pathlike: FancyRegex::new(
            r"[A-Za-z0-9_./-]+\.(?:tsx|ts|json|mjs|cjs|js|md|njk|css|html|yaml|yml)(?![a-z])(?::[0-9]+(?:-[0-9]+)?)?",
        )
        .unwrap(),
        locus_marker: Regex::new(&format!(r"(?:{}):$", locus_prefix_re_source())).unwrap(),
        exempt_field: Regex::new(r"^\s*(?:relatedReport|graduatedTo|crossRef|codifiedIn)\s*:").unwrap(),
        product_js: Regex::new(r"^[A-Z][a-z]+\.js$").unwrap(),
        type_fragment: Regex::new(r"^\.(?:d|test|spec|stories|sw\.spec)\.[a-z]+$").unwrap(),
        md_link_target: Regex::new(r"\]\($").unwrap(),
        at_scope: Regex::new(r"@$").unwrap(),
        url_prefix: Regex::new(r"https?:/*$").unwrap(),
        glob_star: Regex::new(r"\*$").unwrap(),
    })
}

#[derive(Serialize)]
pub struct LocusFinding {
    pub file: String,
    pub count: usize,
    pub sample: String,
}

/// Port of `scanRepoLocusPrefixes`. `content` is the raw file body; `file` is its repo-relative path (used
/// only to label the finding).
pub fn find_locus_prefix_violations(file: &str, content: &str) -> Option<LocusFinding> {
    let p = patterns();
    let no_fenced = p.fenced.replace_all(content, "");
    let mut unmarked: Vec<String> = Vec::new();

    for line in no_fenced.split('\n') {
        if p.exempt_field.is_match(line) {
            continue;
        }
        let mut pos = 0usize;
        while pos <= line.len() {
            let Ok(Some(m)) = p.pathlike.find_from_pos(line, pos) else { break };
            let before = &line[..m.start()];
            let token = m.as_str();
            pos = m.end().max(pos + 1); // advance past this match (or by 1 char if it was zero-width)

            if p.locus_marker.is_match(before) {
                continue;
            }
            if p.md_link_target.is_match(before) {
                continue;
            }
            if p.at_scope.is_match(before) {
                continue;
            }
            if p.url_prefix.is_match(before) {
                continue;
            }
            if p.glob_star.is_match(before) {
                continue;
            }
            if p.product_js.is_match(token) {
                continue;
            }
            if p.type_fragment.is_match(token) {
                continue;
            }
            unmarked.push(token.to_string());
        }
    }

    if unmarked.is_empty() {
        None
    } else {
        Some(LocusFinding { file: file.to_string(), count: unmarked.len(), sample: unmarked[0].clone() })
    }
}

fn list_md_files(root: &Path) -> Vec<(String, std::path::PathBuf)> {
    let mut files = Vec::new();
    for label in ["backlog", "reports"] {
        let dir = root.join(label);
        let entries = match fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        let mut names: Vec<String> = entries
            .flatten()
            .filter_map(|e| {
                let name = e.file_name().to_string_lossy().to_string();
                if name.ends_with(".md") { Some(name) } else { None }
            })
            .collect();
        names.sort();
        for name in names {
            files.push((format!("{label}/{name}"), dir.join(&name)));
        }
    }
    files
}

fn scan_one(rel: &str, path: &Path) -> Option<LocusFinding> {
    let content = fs::read_to_string(path).ok()?;
    find_locus_prefix_violations(rel, &content)
}

/// Sequential reference — kept for the differential test against the JS port.
#[allow(dead_code)]
pub fn scan_locus_prefixes(root: &Path) -> Vec<LocusFinding> {
    list_md_files(root).into_iter().filter_map(|(rel, path)| scan_one(&rel, &path)).collect()
}

pub fn scan_locus_prefixes_parallel(root: &Path) -> Vec<LocusFinding> {
    list_md_files(root).par_iter().filter_map(|(rel, path)| scan_one(rel, path)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hit(content: &str) -> Option<LocusFinding> {
        find_locus_prefix_violations("x.md", content)
    }

    #[test]
    fn bare_path_flagged() {
        let f = hit("see scripts/check-standards.mjs for details").unwrap();
        assert_eq!(f.sample, "scripts/check-standards.mjs");
        assert_eq!(f.count, 1);
    }

    #[test]
    fn we_prefixed_path_passes() {
        assert!(hit("see we:scripts/check-standards.mjs for details").is_none());
    }

    #[test]
    fn fenced_code_block_is_stripped() {
        assert!(hit("```\nscripts/check-standards.mjs\n```").is_none());
    }

    #[test]
    fn markdown_link_target_passes() {
        assert!(hit("[we:scripts/x.ts](scripts/x.ts)").is_none());
    }

    #[test]
    fn npm_scope_specifier_passes() {
        assert!(hit("install @scope/pkg.json today").is_none());
    }

    #[test]
    fn url_passes() {
        assert!(hit("see https://example.com/foo.js for docs").is_none());
    }

    #[test]
    fn glob_mask_passes() {
        assert!(hit("matches *.test.ts everywhere").is_none());
    }

    #[test]
    fn product_js_name_passes() {
        assert!(hit("built with Node.js and Next.js").is_none());
    }

    #[test]
    fn type_fragment_passes() {
        assert!(hit("ships a .d.ts and a .spec.ts").is_none());
    }

    #[test]
    fn exempt_frontmatter_field_passes() {
        assert!(hit("relatedReport: reports/2026-01-01-foo.md").is_none());
    }

    #[test]
    fn line_range_locus_flagged_as_one_token() {
        let f = hit("bug at scripts/check-standards.mjs:120-140 today").unwrap();
        assert_eq!(f.sample, "scripts/check-standards.mjs:120-140");
    }

    #[test]
    fn jsonl_like_suffix_not_falsely_matched_as_json() {
        // The negative lookahead `(?![a-z])`: `.json` immediately followed by a lowercase letter (as in a
        // hypothetical `.jsonl`-shaped token) must not match as a bare `.json` reference.
        assert!(hit("data.jsonlines has no repo path here").is_none());
    }

    #[test]
    fn multiple_findings_in_one_file_all_counted() {
        let f = hit("scripts/a.mjs and scripts/b.mjs both bare").unwrap();
        assert_eq!(f.count, 2);
        assert_eq!(f.sample, "scripts/a.mjs");
    }

    #[test]
    fn sequential_and_parallel_scans_agree() {
        let dir = std::env::temp_dir().join(format!("we-scan-locus-test-{}", std::process::id()));
        let backlog = dir.join("backlog");
        fs::create_dir_all(&backlog).unwrap();
        fs::write(backlog.join("a.md"), "see scripts/check-standards.mjs for details\n").unwrap();
        fs::write(backlog.join("b.md"), "see we:scripts/x.ts — already marked\n").unwrap();

        let seq = scan_locus_prefixes(&dir);
        let par = scan_locus_prefixes_parallel(&dir);
        fs::remove_dir_all(&dir).ok();

        let norm = |v: Vec<LocusFinding>| -> Vec<String> {
            let mut s: Vec<String> = v.into_iter().map(|f| format!("{}:{}:{}", f.file, f.count, f.sample)).collect();
            s.sort();
            s
        };
        assert_eq!(norm(seq), norm(par));
    }
}

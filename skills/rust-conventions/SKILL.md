---
name: rust-conventions
description: "Rust code style, structure, testing, and completeness conventions. Load when writing, reviewing, or refactoring Rust: clippy pedantic, imports, module splitting, test patterns, flaky avoidance, definition of done."
license: MIT
user-invocable: true
metadata:
  author: vanillagreen
  version: "1.0.0"
---

# Rust Conventions

Style, testing, structure, and completeness rules for Rust codebases, prioritized by impact from high (code structure, testing, completeness) to medium (style, navigation, gotchas).

## Resources

### ctx7 CLI

| Library | ctx7 ID | Use For |
|---------|---------|---------|
| Rust std | `/websites/doc_rust-lang_stable_std` | Standard library API |
| tokio | `/websites/rs_tokio` | Async runtime |
| serde | `/websites/rs_serde` | Serialization |

## Skill Rules

### Style and Formatting

Consistent Rust code style -- clippy pedantic, imports, doc comments, safety comments.

#### Doc Comment Conventions

- Backticks for all code refs: `Box::into_raw`, `repr(C)`, `UnsafeCell`
- Full paths for external items: `std::mem::MaybeUninit`
- Add `# Panics` doc section if function can panic
- Add `# Errors` doc section if function returns `Result`
- Add `#[must_use]` on pure functions returning values

#### Clippy Pedantic

For projects running `-W clippy::pedantic -D warnings`:

- `#[inline]` not `#[inline(always)]` -- let compiler decide
- Prefer `&T` over owned `T` for non-consumed params (`needless_pass_by_value`)
- `#[repr(...)]` before `#[derive(...)]`
- Run `cargo fmt` before commit -- always
- Don't manually align inline comments -- `cargo fmt` normalizes them

##### Casting Lints

Pedantic flags `as` casts. Add `#[allow(clippy::...)]` with a justification comment:

| Lint | When |
|------|------|
| `cast_possible_truncation` | `u128 as u64`, `usize as u16` -- bounded values |
| `cast_sign_loss` | `i32 as u32` on known-positive/negated values |
| `cast_possible_wrap` | `usize as i32` for returns bounded by design |

#### Import Conventions

- **Module-level imports** -- `use` statements at top of file. Feature-gated: `#[cfg(feature = "X")] use crate::module::Thing;`. Function-level only when: single use AND would cause name clash.
- **Grouping order**: std -> external crates -> `crate::` -> `super::`/`self::`. Blank line between groups.
- **Prefer**: modules, types, macros. Use qualified paths for functions: `module::function()`.
- **Avoid glob imports** except: preludes, `use super::*` in test modules.
- **Avoid enum variant imports** except: `Some`, `None`, `Ok`, `Err`.

#### Safety Comments

Document every `unsafe` block with a `// SAFETY:` comment explaining why invariants hold. Items `pub` only for benchmark/integration test access get `#[doc(hidden)]` to suppress `missing_docs`.

### Code Structure

How to organize and split Rust code -- file limits, modularity, extraction patterns.

#### No Magic Numbers

Numeric literals used more than once or with non-obvious meaning must be named constants (`const` at module top). Includes: thresholds, percentages, pixel sizes, timing values. Exception: 0, 1, 2 in obvious contexts.

#### Single Source of Initialization

When two constructors initialize the same fields, one must call the other or both call a shared helper.

#### Extract Shared Computation

If two functions compute the same derived values (geometry, dimensions, layout), extract to a shared struct or helper.

#### Early Return on No-Op

Functions called every frame (view, overlay builders) must early-return when their output is unused (e.g., no active drag -> skip overlay construction).

#### Split at 5+ Match Arms

When a handler dispatches 5+ message types with non-trivial logic, split into focused helpers. The dispatcher becomes a thin match -> method call.

#### Per-Instance State

When different instances (panes, tabs, widgets) have different dimensions/state, store per-instance. A single global field silently returns wrong data for the non-last-updated instance.

#### File Size Limits

- Implementation: <=1,500 lines per file. Approaching limit -> split proactively by responsibility.
- Test files: <=1,000 lines target, 1,500 hard limit.
- Split by contract, not by size: each module gets one clear responsibility and a minimal public API. Group by coupling (types + functions that change together stay together). Thin dispatchers stay in the parent; logic moves to focused modules.
- Never split types from the functions that exclusively operate on them.

#### Declarative vs Imperative

- Configuration/setup -> declarative (structs, builders, config files)
- Hot path execution -> imperative (explicit control, zero-cost)
- Cold path queries -> declarative acceptable (SQL, iterators)
- UI bindings -> declarative (Elm architecture, reactive patterns)

### Testing

Test structure, flaky test avoidance, and test quality.

#### Unit Test Path Pattern

Sibling file pattern for `pub(crate)` access:
- `module.rs` + `module_tests.rs` in same directory
- Source declares: `#[cfg(test)] #[path = "module_tests.rs"] mod tests;`
- Test imports: `use super::*;`

When a test file exceeds 1,000 lines, split into focused modules with descriptive names. Split modules may use explicit `use super::Type` or `use crate::` imports.

#### Test Feature Gates

- **Infrastructure features**: Module-level gating (`#[cfg(all(test, feature = "X"))]` on module declaration), not per-item `#[cfg]` on each test.
- **MIRI/sanitizer gating**: Test modules that don't exercise unsafe code -> `#[cfg(all(test, not(miri)))]`. MIRI/ASAN only detect UB and memory errors in unsafe code.
- **Loom ordering models**: In-source `#[cfg(loom)] mod loom_tests` permitted in `#[path]` test files for simplified atomic ordering models co-located with the code they verify.

#### Test Modules Mirror Production

When production responsibilities split into focused files, move the matching focused tests and shared fixtures into sibling `#[path]` test modules in the same change. Do not leave the old catch-all test file as the stale owner.

#### Flaky Test Avoidance

- **Use signals, not iteration counts** -- `while !done.load()` not `for _ in 0..10000`
- **Startup barriers before concurrent work** -- ensure all threads ready before test begins
- **spin_loop() is not synchronization** -- use `yield_now()`, channels, or condition variables
- **No static mutable state in tests** -- use thread_local or per-test instances
- **Parallel tests must be isolated** -- shared global state = flaky failures in CI
- **Drain loops bounded by known quantities** -- track actual counts, not arbitrary iterations
- **Never rely on timing** -- `sleep()` for synchronization is a bug waiting to happen
- **No probabilistic aggregate assertions** -- each iteration must be self-contained

#### Test Quality

- **Verify setup reaches target** -- trace call chains before copying patterns. Early-throwing mocks can shadow later overrides.
- **Question existing patterns** -- "parity" work propagates flaws silently. Verify originals are sound.
- **Names must match behavior** -- `WhenXThrows` but X never runs = misleading test.

### Completeness

Definition of done -- when tests, benchmarks, and docs are required. Prevents gaps in coverage and undocumented public APIs.

#### New Public Functions Require Tests

Unit test for happy path + at least one error case. Exception: trivial getters/setters, generated code. Don't reduce coverage without reason -- removing tests requires explanation in commit message. Moving/consolidating tests is fine; deleting without replacement is not.

#### Benchmarks for Hot Paths

When adding performance-sensitive code, add a Criterion benchmark. Benchmarked types must be `pub` (benches/ is an external crate). If modifying an existing hot path, verify the existing benchmark covers your change. Integration tests go in `tests/`; benchmarks go in `benches/`.

#### Definition of Done

- Code compiles with no warnings
- Tests exist for new behavior
- Benchmarks exist if hot path
- Docs updated if public API
- No incomplete code -- every commit must be production-ready
- Measure everything -- no optimization without benchmarks
- Profile before claiming -- performance claims need proof
- Fix at the source -- change defaults, don't add options. Fix the producer, not consumers.
- Concise over verbose when equivalent

### Navigation

How to explore Rust codebases efficiently using LSP and grep.

#### LSP vs Grep

- **Semantic queries -> LSP** -- findReferences, goToDefinition, incomingCalls for understanding code structure and impact
- **Text patterns -> Grep** -- string literals, log messages, config keys
- **Before refactoring** -- Use LSP findReferences to understand full impact
- **Type uncertainty** -- Use LSP hover instead of reading entire files
- **LSP returns 0 results?** -- Don't trust it; fall back to Grep. Position mapping is unreliable.
- **Stale diagnostics after commits** -- Verify with `cargo check` before acting on LSP warnings.

### Gotchas

Specific Rust language footguns that cause subtle bugs.

#### 0.is_multiple_of(n) Returns True

RFC 2413: 0 is a multiple of every integer. Guard sampling/rate-limiting:

**Incorrect:**

```rust
if poll_count.is_multiple_of(INTERVAL) { log_metrics(); }
// Fires immediately at poll_count == 0
```

**Correct:**

```rust
if poll_count > 0 && poll_count.is_multiple_of(INTERVAL) { log_metrics(); }
```

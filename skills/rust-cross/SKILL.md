---
name: rust-cross
description: "Cross-compilation for Rust: target triples, .cargo/config.toml, cross/zigbuild, -Zbuild-std, musl static binaries, OpenSSL strategies, QEMU testing, conditional compilation. Load when building for non-native targets or configuring multi-platform CI."
license: MIT
user-invocable: true
metadata:
  author: vanillagreen
  version: "1.0.0"
---

# Rust Cross-Compilation

Target configuration, cross-compilation tools, static binary recipes, and multi-platform CI for Rust projects.

## Resources

### ctx7 CLI

| Library | ctx7 ID | Use For |
|---------|---------|---------|
| Rust std | `/websites/doc_rust-lang_stable_std` | Standard library API |
| cross | `/cross-rs/cross` | Docker-based cross-compilation |

## Skill Rules

### Target Configuration

Target triple format, rustup setup, and cargo configuration for cross-compilation.

#### Cargo Config for Cross-Compilation

Use `.cargo/config.toml` in the project root for per-target settings. Keep platform-specific configuration in the project, not in user-global `~/.cargo/config.toml`, so all contributors and CI share the same setup.

**Incorrect:**

```toml
# ~/.cargo/config.toml (global — not shared with team or CI)
[build]
target = "aarch64-unknown-linux-gnu"

# Then relying on environment variables in scripts:
# RUSTFLAGS="-C target-feature=+crt-static" cargo build
# This is fragile and not reproducible
```

**Correct:**

```toml
# .cargo/config.toml (committed to repo)

# Default build target (optional — set only if project is single-target)
# [build]
# target = "aarch64-unknown-linux-gnu"

# Per-target linker and runner configuration
[target.aarch64-unknown-linux-gnu]
linker = "aarch64-linux-gnu-gcc"
runner = "qemu-aarch64 -L /usr/aarch64-linux-gnu"

[target.x86_64-unknown-linux-musl]
rustflags = ["-C", "target-feature=+crt-static"]

# Environment variables for cross-compilation
[env]
# OPENSSL_STATIC = "1"
# OPENSSL_DIR = "/usr/local/musl"
```

### Cross-Compilation Tools

Docker-based cross, Zig-based zigbuild, and nightly build-std for cross-compiling Rust.

#### Cargo Zigbuild

`cargo-zigbuild` uses Zig as a drop-in C/C++ cross-compiler. No Docker. Key advantage: precise glibc version targeting with `--target aarch64-unknown-linux-gnu.2.17`. Better than `cross` for CI without Docker, precise glibc control, and mixed C/Rust projects.

**Incorrect:**

```bash
# Default build links against host glibc (e.g., 2.35)
cargo build --target aarch64-unknown-linux-gnu --release
# Binary fails on RHEL 7 / CentOS 7 (glibc 2.17):
# ./myapp: /lib64/libc.so.6: version `GLIBC_2.28' not found
```

**Correct:**

```bash
# Install zigbuild and Zig
cargo install cargo-zigbuild
pip install ziglang
# Or: snap install zig --classic

# Build with precise glibc version targeting
cargo zigbuild --target aarch64-unknown-linux-gnu.2.17 --release
# Binary works on any Linux with glibc >= 2.17

# Also works for x86_64
cargo zigbuild --target x86_64-unknown-linux-gnu.2.17 --release

# No Docker, no container overhead, fast builds
```

#### Build-std (Nightly)

`-Zbuild-std` rebuilds the standard library from source for custom targets. Required for bare-metal/embedded targets not available via `rustup`. Nightly-only. Use a custom target specification JSON for exotic platforms with custom data layouts, linker flavors, or panic behavior.

**Incorrect:**

```rust
// cargo build --target thumbv7em-none-eabihf
// Error: can't find crate for `core`
//
// Or trying to use a custom target JSON:
// cargo build --target my-custom-target.json
// Error: no pre-built std available for this target
```

**Correct:**

```bash
# Install nightly and rust-src component
rustup toolchain install nightly
rustup component add rust-src --toolchain nightly

# Build with core + alloc (no_std with heap allocation)
cargo +nightly build -Zbuild-std=core,alloc \
  --target thumbv7em-none-eabihf --release

# For custom targets, create a target spec JSON:
# my-target.json
```

```json
{
  "llvm-target": "thumbv7em-none-eabihf",
  "data-layout": "e-m:e-p:32:32-Fi8-i64:64-v128:64:128-a:0:32-n32-S64",
  "arch": "arm",
  "os": "none",
  "env": "eabihf",
  "linker-flavor": "gnu-lld-cc",
  "linker": "arm-none-eabi-gcc",
  "panic-strategy": "abort",
  "features": "+thumb2,+v7,+vfp4,-d32"
}
```

```bash
# Build with custom target spec
cargo +nightly build -Zbuild-std=core,alloc \
  --target my-target.json --release
```

### Static Binaries

musl-based static linking and OpenSSL strategies for portable binaries. Dynamic linking to glibc causes "GLIBC not found" errors on older systems and containers.

#### OpenSSL Strategies for Cross Builds

OpenSSL is a C library that requires target-specific headers and libraries. Four strategies exist, ordered by preference. For new projects, always prefer rustls. For existing projects with deep openssl dependency, use vendored.

**Incorrect:**

```bash
# Cross-compiling a project that depends on openssl crate:
cargo build --target aarch64-unknown-linux-gnu --release
# error: failed to run custom build command for `openssl-sys`
# Could not find directory of OpenSSL installation
```

**Correct:**

```toml
# Strategy 1 (BEST): Switch to rustls — no C dependency at all
# Cargo.toml
[dependencies]
reqwest = { version = "0.12", default-features = false, features = ["rustls-tls"] }
# Most HTTP/TLS crates support rustls as an alternative backend

# Strategy 2: Vendored OpenSSL — builds from source, slow but portable
[dependencies]
openssl = { version = "0.10", features = ["vendored"] }
# This compiles OpenSSL from source for the target — adds ~60s to build
# Works with any target, no pre-built libraries needed

# Strategy 3: Pre-build in Cross.toml Dockerfile
# Cross.toml
# [target.aarch64-unknown-linux-gnu]
# dockerfile = "cross/Dockerfile.aarch64"
# Where Dockerfile installs target-specific libssl-dev

# Strategy 4: OPENSSL_STATIC=1 with zigbuild
# OPENSSL_STATIC=1 OPENSSL_DIR=/path/to/openssl \
#   cargo zigbuild --target aarch64-unknown-linux-gnu --release
```

### Testing and CI

QEMU testing, GitHub Actions matrix builds, and conditional compilation patterns.

#### QEMU Testing for Cross Targets

Use QEMU to run cross-compiled test binaries on the host machine. The `cross` tool includes QEMU automatically. For manual setup, configure the QEMU runner in `.cargo/config.toml`. Testing on ARM64 catches memory ordering bugs hidden by x86's strong TSO memory model.

**Incorrect:**

```rust
// Code with relaxed atomics that works on x86 (TSO) but breaks on ARM:
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

static FLAG: AtomicBool = AtomicBool::new(false);
static DATA: AtomicU64 = AtomicU64::new(0);

// Writer
DATA.store(42, Ordering::Relaxed);
FLAG.store(true, Ordering::Relaxed);  // No release barrier

// Reader — on ARM, may see FLAG=true but DATA=0
if FLAG.load(Ordering::Relaxed) {
    assert_eq!(DATA.load(Ordering::Relaxed), 42); // Can fail on ARM!
}
```

**Correct:**

```toml
# .cargo/config.toml — configure QEMU runner
[target.aarch64-unknown-linux-gnu]
linker = "aarch64-linux-gnu-gcc"
runner = "qemu-aarch64 -L /usr/aarch64-linux-gnu"
```

```bash
# Option 1: Using cross (includes QEMU automatically)
cross test --target aarch64-unknown-linux-gnu

# Option 2: Manual QEMU setup
sudo apt install qemu-user qemu-user-static
rustup target add aarch64-unknown-linux-gnu
sudo apt install gcc-aarch64-linux-gnu
cargo test --target aarch64-unknown-linux-gnu
# cargo uses the runner from .cargo/config.toml automatically
```

#### Conditional Compilation

Use `#[cfg(...)]` attributes for platform-specific code. Test ALL cfg branches in CI by building against each target. Use `cfg_if` for complex conditions. Code behind `#[cfg]` that is never compiled in CI will accumulate errors silently.

**Incorrect:**

```rust
// Platform-specific code that is never compiled in CI:
#[cfg(target_os = "linux")]
fn get_cpu_count() -> usize {
    // This compiles and is tested
    num_cpus::get()
}

#[cfg(target_os = "macos")]
fn get_cpu_count() -> usize {
    // This is never compiled in CI — may have syntax errors,
    // missing imports, or wrong API usage that goes undetected
    sysctl_get_cpu_count()  // Does this function even exist?
}

// Per-item cfg scattered everywhere:
#[cfg(target_arch = "aarch64")]
use std::arch::aarch64::*;
#[cfg(target_arch = "x86_64")]
use std::arch::x86_64::*;
#[cfg(target_arch = "aarch64")]
fn fast_path() { /* ... */ }
#[cfg(target_arch = "x86_64")]
fn fast_path() { /* ... */ }
```

**Correct:**

```rust
// Use cfg_if for complex platform branching
use cfg_if::cfg_if;

cfg_if! {
    if #[cfg(target_os = "linux")] {
        mod linux_impl;
        pub use linux_impl::get_cpu_count;
    } else if #[cfg(target_os = "macos")] {
        mod macos_impl;
        pub use macos_impl::get_cpu_count;
    } else {
        // Fallback — compile error on unsupported platforms
        compile_error!("Unsupported OS: add a get_cpu_count implementation");
    }
}

// Group platform-specific code into modules, not scattered per-item
#[cfg(target_arch = "aarch64")]
mod simd_aarch64;
#[cfg(target_arch = "x86_64")]
mod simd_x86;

// Verify all cfg branches compile in CI:
// cargo check --target x86_64-unknown-linux-gnu
// cargo check --target aarch64-unknown-linux-gnu
// cargo check --target x86_64-apple-darwin
```

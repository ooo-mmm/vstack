---
name: rust-ffi
description: "Rust FFI patterns for safe C interop. Load when writing extern \"C\" functions, repr(C) types, CStr/CString, pointer+length slices, Box::into_raw ownership, bindgen/cbindgen, sys-crate splitting, or handle wrappers with Drop."
license: MIT
user-invocable: true
metadata:
  author: vanillagreen
  version: "1.0.0"
---

# Rust FFI

Safe and correct patterns for Rust Foreign Function Interface boundaries, prioritized by impact from critical (data handling) to high (bindgen/cbindgen, safe wrappers). Violations at the critical level cause undefined behavior -- mismatched allocators corrupt the heap, missing null terminators cause buffer overreads. Higher-level violations cause resource leaks, unsound abstractions, and tangled safe/unsafe code.

## Resources

### ctx7 CLI

| Library | ctx7 ID | Use For |
|---------|---------|---------|
| Rust std | `/websites/doc_rust-lang_stable_std` | Standard library FFI types (CStr, CString, NonNull) |
| libc | `/rust-lang/libc` | C type definitions and platform constants |
| bindgen | `/rust-lang/rust-bindgen` | Generating Rust FFI bindings from C headers |
| cbindgen | `/mozilla/cbindgen` | Generating C headers from Rust exports |

## Skill Rules

### String and Data Handling

String, slice, and owned data conversion across the Rust/C boundary.

#### CStr/CString for C String Conversion

C strings are null-terminated, Rust strings are not. Use `CStr::from_ptr` for C-to-Rust (borrowed, zero-copy). Use `CString::new` for Rust-to-C (allocates, adds null terminator). `CString::new` can fail if input contains an interior null byte. Never use `str::as_ptr` for FFI -- the resulting pointer is not null-terminated.

**Incorrect (using str::as_ptr for FFI):**

```rust
let name = "hello";
unsafe {
    // BUG: str::as_ptr is NOT null-terminated — C will read past the end
    c_set_name(name.as_ptr() as *const std::ffi::c_char);
}
```

**Correct (CStr for receiving, CString for sending):**

```rust
use std::ffi::{CStr, CString, c_char};

// C → Rust (borrowed, zero-copy):
unsafe fn read_c_string(ptr: *const c_char) -> Result<&str, std::str::Utf8Error> {
    // SAFETY: ptr is non-null and points to a valid null-terminated C string
    let cstr = unsafe { CStr::from_ptr(ptr) };
    cstr.to_str()
}

// Rust → C (allocates, adds null terminator):
fn send_to_c(name: &str) -> Result<(), Box<dyn std::error::Error>> {
    let c_name = CString::new(name)?; // Fails if name contains \0
    unsafe {
        c_set_name(c_name.as_ptr());
    }
    // c_name must live until C is done with the pointer
    Ok(())
}
```

#### Pass Slices as Pointer + Length

Slices are `(ptr, len)` -- C has no slice type. Pass as separate pointer + length parameters. Validate: non-null, length within allocation, alignment correct. Use `slice::from_raw_parts` with a SAFETY comment documenting all preconditions. For mutable: `slice::from_raw_parts_mut`, ensure exclusive access.

**Incorrect (no validation, missing SAFETY comment):**

```rust
#[no_mangle]
pub extern "C" fn sum_array(data: *const f64, len: usize) -> f64 {
    unsafe {
        // No null check, no SAFETY comment, no length validation
        let slice = std::slice::from_raw_parts(data, len);
        slice.iter().sum()
    }
}
```

**Correct (validated with SAFETY comment):**

```rust
#[no_mangle]
pub extern "C" fn sum_array(data: *const f64, len: usize) -> f64 {
    if data.is_null() || len == 0 {
        return 0.0;
    }

    // SAFETY:
    // - Caller guarantees `data` points to `len` contiguous f64 values
    // - Caller guarantees the memory is valid for the duration of this call
    // - data is non-null (checked above)
    // - f64 has no alignment issues on any supported platform
    let slice = unsafe { std::slice::from_raw_parts(data, len) };
    slice.iter().sum()
}

// Mutable version — caller must guarantee exclusive access:
#[no_mangle]
pub extern "C" fn zero_array(data: *mut f64, len: usize) {
    if data.is_null() || len == 0 {
        return;
    }

    // SAFETY:
    // - Same preconditions as above
    // - Caller guarantees no other references to this memory exist
    let slice = unsafe { std::slice::from_raw_parts_mut(data, len) };
    slice.fill(0.0);
}
```

#### Box::into_raw/from_raw for Ownership Transfer

Use `Box::into_raw` to give ownership to C (Rust stops managing memory). Use `Box::from_raw` to reclaim (C must not have freed it). Never free Rust memory with C's `free()` or vice versa -- allocators are incompatible. Document ownership in API: "caller must call `X_free()` to release". Pattern: constructor returns `*mut T`, destructor takes `*mut T`.

**Incorrect (freeing Rust allocation with C free):**

```rust
#[no_mangle]
pub extern "C" fn create_config() -> *mut Config {
    Box::into_raw(Box::new(Config::default()))
}

// In C code:
// Config* cfg = create_config();
// free(cfg); // BUG: C's free() doesn't know about Rust's allocator
```

**Correct (paired constructor/destructor):**

```rust
/// Creates a new Config. Caller must call `config_free()` to release.
#[no_mangle]
pub extern "C" fn config_new() -> *mut Config {
    Box::into_raw(Box::new(Config::default()))
}

/// Frees a Config created by `config_new()`. Passing null is a no-op.
#[no_mangle]
pub extern "C" fn config_free(ptr: *mut Config) {
    if ptr.is_null() {
        return;
    }
    // SAFETY: ptr was created by Box::into_raw in config_new()
    // and has not been freed yet (caller's contract)
    unsafe {
        drop(Box::from_raw(ptr));
    }
}
```

### Bindgen and Cbindgen

Automated binding generation and sys-crate organization.

#### Sys Crate + Safe Wrapper Pattern

Split into `mylib-sys` (raw bindings) + `mylib` (safe wrapper). sys crate: `links = "mylib"` in `Cargo.toml`, `build.rs` for linking, raw `extern "C"` declarations. Wrapper crate: safe Rust API, handle `Drop` cleanup, error conversion, lifetime tracking.

**Incorrect (raw bindings and safe API mixed in one crate):**

```rust
// lib.rs — everything in one place, unsafe scattered throughout
extern "C" {
    fn mylib_init() -> *mut Handle;
    fn mylib_process(h: *mut Handle, data: *const u8, len: usize) -> i32;
    fn mylib_free(h: *mut Handle);
}

pub fn process(data: &[u8]) -> Result<(), Error> {
    let h = unsafe { mylib_init() };  // raw FFI mixed with safe code
    // ...
}
```

**Correct (separate sys + wrapper crates):**

```toml
# mylib-sys/Cargo.toml
[package]
name = "mylib-sys"
links = "mylib"
build = "build.rs"
```

```rust
// mylib-sys/src/lib.rs — raw bindings only, no safe wrappers
#![allow(non_camel_case_types)]
extern "C" {
    pub fn mylib_init() -> *mut mylib_handle;
    pub fn mylib_process(h: *mut mylib_handle, data: *const u8, len: usize) -> i32;
    pub fn mylib_free(h: *mut mylib_handle);
}

#[repr(C)]
pub struct mylib_handle {
    _private: [u8; 0],
}
```

```rust
// mylib/src/lib.rs — safe wrapper
use mylib_sys as ffi;

pub struct Handle {
    inner: std::ptr::NonNull<ffi::mylib_handle>,
}

impl Handle {
    pub fn new() -> Result<Self, Error> {
        let ptr = unsafe { ffi::mylib_init() };
        let inner = std::ptr::NonNull::new(ptr).ok_or(Error::InitFailed)?;
        Ok(Self { inner })
    }

    pub fn process(&mut self, data: &[u8]) -> Result<(), Error> {
        let rc = unsafe {
            ffi::mylib_process(self.inner.as_ptr(), data.as_ptr(), data.len())
        };
        if rc != 0 { return Err(Error::from_code(rc)); }
        Ok(())
    }
}

impl Drop for Handle {
    fn drop(&mut self) {
        unsafe { ffi::mylib_free(self.inner.as_ptr()) };
    }
}
```

### Safe Wrappers

Wrapping raw C handles and callbacks in safe Rust abstractions.

#### Wrap C Handles in Newtype with Drop

Wrap raw C handles in a newtype struct. Implement `Drop` for cleanup (call C destructor). Don't implement `Clone` unless C supports ref-counting. Implement `Send`/`Sync` ONLY after verifying thread safety of the underlying C library. Mark `!Send`/`!Sync` explicitly with `PhantomData` if unsure.

**Incorrect (raw handle without wrapper):**

```rust
let handle = unsafe { c_lib_open(path.as_ptr()) };
// ... use handle ...
// Forgot to call c_lib_close(handle) — resource leak
// Also: is this handle safe to send to another thread?
```

**Correct (newtype with Drop and explicit thread safety):**

```rust
use std::marker::PhantomData;

pub struct LibHandle {
    raw: *mut ffi::c_lib_handle,
    // Mark as !Send + !Sync until C lib thread safety is verified
    _marker: PhantomData<*mut ()>,
}

impl LibHandle {
    pub fn open(path: &str) -> Result<Self, Error> {
        let c_path = std::ffi::CString::new(path)?;
        let raw = unsafe { ffi::c_lib_open(c_path.as_ptr()) };
        if raw.is_null() {
            return Err(Error::OpenFailed);
        }
        Ok(Self { raw, _marker: PhantomData })
    }
}

impl Drop for LibHandle {
    fn drop(&mut self) {
        // SAFETY: self.raw was created by c_lib_open and hasn't been closed
        unsafe { ffi::c_lib_close(self.raw) };
    }
}

// Only add after verifying the C library is thread-safe:
// unsafe impl Send for LibHandle {}
// unsafe impl Sync for LibHandle {}
```

#### PhantomData Lifetime Binding for Borrowed Handles

Use `PhantomData<&'a ()>` to tie wrapper lifetime to parent. Borrowed handles: `struct Ref<'a> { ptr: *const T, _marker: PhantomData<&'a T> }`. This prevents use-after-free at compile time. For callbacks: ensure the closure outlives the C registration.

**Incorrect (borrowed handle without lifetime binding):**

```rust
pub struct DatabaseRef {
    ptr: *const ffi::db_ref,
}

impl Database {
    pub fn get_ref(&self) -> DatabaseRef {
        DatabaseRef { ptr: unsafe { ffi::db_get_ref(self.raw) } }
    }
}

// BUG: db_ref can outlive Database — use-after-free
let db_ref = {
    let db = Database::open("test.db").unwrap();
    db.get_ref() // db dropped here, db_ref now dangling
};
```

**Correct (lifetime-bound borrowed handle):**

```rust
use std::marker::PhantomData;

pub struct DatabaseRef<'a> {
    ptr: *const ffi::db_ref,
    _marker: PhantomData<&'a Database>,
}

impl Database {
    pub fn get_ref(&self) -> DatabaseRef<'_> {
        DatabaseRef {
            ptr: unsafe { ffi::db_get_ref(self.raw) },
            _marker: PhantomData,
        }
    }
}

// Compile error: db_ref borrows db, so it can't outlive it
// let db_ref = {
//     let db = Database::open("test.db").unwrap();
//     db.get_ref() // ERROR: db does not live long enough
// };
```

#### Catch Panics at FFI Callback Boundary

C callbacks must be `extern "C" fn`. Use `Box::into_raw` for closure context, `Box::from_raw` in destructor. Catch panics at FFI boundary: `std::panic::catch_unwind` -- unwinding through C frames is UB. Always register an unwind destructor.

**Incorrect (panic can unwind through C):**

```rust
extern "C" fn my_callback(ctx: *mut std::ffi::c_void) {
    let data = unsafe { &*(ctx as *const MyData) };
    // If this panics, the unwind crosses C frames — UB
    data.process().unwrap();
}
```

**Correct (panic caught at boundary):**

```rust
extern "C" fn my_callback(ctx: *mut std::ffi::c_void) -> i32 {
    let result = std::panic::catch_unwind(|| {
        // SAFETY: ctx was created by Box::into_raw in register_callback
        let data = unsafe { &*(ctx as *const MyData) };
        data.process()
    });

    match result {
        Ok(Ok(())) => 0,      // Success
        Ok(Err(_)) => -1,     // Application error
        Err(_) => {
            // Panic caught — log and return error code
            eprintln!("panic in FFI callback");
            -2
        }
    }
}

// Register with closure context:
pub fn register_callback(data: MyData) {
    let boxed = Box::new(data);
    let ctx = Box::into_raw(boxed) as *mut std::ffi::c_void;
    unsafe { ffi::set_callback(Some(my_callback), ctx) };
}

// Destructor to reclaim the context:
extern "C" fn destroy_callback_ctx(ctx: *mut std::ffi::c_void) {
    if !ctx.is_null() {
        // SAFETY: ctx was created by Box::into_raw in register_callback
        unsafe { drop(Box::from_raw(ctx as *mut MyData)) };
    }
}
```

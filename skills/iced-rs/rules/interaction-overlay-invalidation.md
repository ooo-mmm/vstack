---
title: Overlay Visibility Requires Layout Invalidation
impact: MEDIUM
impactDescription: Stale layout nodes cause panics after overlay visibility toggles
tags: overlay, invalidate_layout, custom_widget, tooltip
---

## Overlay Visibility Requires Layout Invalidation

**Impact: MEDIUM (stale layout nodes cause panics after overlay visibility toggles)**

Custom widgets that conditionally return an overlay from `overlay()` must call `shell.invalidate_layout()` in `update()` whenever the overlay appears or disappears. Without this, the popup tree's layout nodes go stale between `layout()` and `draw()`, causing panics like `container.rs unwrap() on None`. This is the same contract Iced's built-in `tooltip::Tooltip` follows — `shell.invalidate_layout()` on every `Open`↔`Idle` transition. Symptom: crash at `iced_widget/src/container.rs` after repeated hover cycling.

**Incorrect (no invalidation on visibility change):**

```rust
fn update(&mut self, _state: &mut Tree, event: Event, ..., shell: &mut Shell<'_, Message>) {
    match event {
        Event::Mouse(mouse::Event::CursorEntered) => {
            self.show_overlay = true;
            // BUG: layout tree still has no overlay node
        }
        Event::Mouse(mouse::Event::CursorLeft) => {
            self.show_overlay = false;
        }
        _ => {}
    }
}

fn overlay<'b>(...) -> Option<overlay::Element<'b, Message, Theme, Renderer>> {
    if self.show_overlay { Some(my_popup(...)) } else { None }
}
```

**Correct (invalidate layout on every visibility transition):**

```rust
fn update(&mut self, _state: &mut Tree, event: Event, ..., shell: &mut Shell<'_, Message>) {
    match event {
        Event::Mouse(mouse::Event::CursorEntered) => {
            if !self.show_overlay {
                self.show_overlay = true;
                shell.invalidate_layout();
            }
        }
        Event::Mouse(mouse::Event::CursorLeft) => {
            if self.show_overlay {
                self.show_overlay = false;
                shell.invalidate_layout();
            }
        }
        _ => {}
    }
}

fn overlay<'b>(...) -> Option<overlay::Element<'b, Message, Theme, Renderer>> {
    if self.show_overlay { Some(my_popup(...)) } else { None }
}
```

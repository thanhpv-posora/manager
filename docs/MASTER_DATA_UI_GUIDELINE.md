# MeatBiz Master Data UI Guideline

**Path note:** No dedicated frontend/UI/design-system documentation directory exists in `docs/` today (checked `docs/checklists/`, `docs/playbooks/`, and every numbered `0X-*` folder — none is a better fit for a UI/UX contract than the default location given in this task). This document lives at `docs/MASTER_DATA_UI_GUIDELINE.md` as instructed.

Every claim in this document is labeled with its status:
- **[EXISTING]** — already implemented in the codebase today, evidenced below.
- **[NEW — Dialog refactor]** — established by the recent Product/Partner Dialog standardization work, now the pattern for Master Data screens going forward.
- **[RECOMMENDED — not yet implemented]** — a suggestion for future work, explicitly not claimed as current behavior.

---

## 1. Purpose and Scope
This document is the UI/UX design contract for MeatBiz **Master Data** management screens — reference/configuration entities that are created once and edited occasionally, as opposed to transactional screens (POS, Orders, Payments). Verified current examples: **Products** (`frontend/src/pages/Products.jsx`), **Partners/Customers** (`frontend/src/pages/Customers.jsx`). Named in the task as future candidates — **not yet verified as migrated to this standard**: Categories, Units, Warehouses, Price Categories, Price Books, Supplier Purchase Options. `frontend/src/pages/SupplierPurchaseOptions.jsx` was inspected as a second reference screen; it has **not** adopted the Dialog pattern (its form is still an always-visible inline card) — cited here only as evidence of the *pre-Dialog* baseline this guideline supersedes for Master Data screens.

## 2. Core Principles
1. **[EXISTING]** Business correctness over visual novelty (MEATBIZ.md Golden Rule #1) — this guideline governs presentation only, never validation or API contracts.
2. **[NEW]** One reusable `Dialog` component for Add/Edit, not a page-specific modal per module.
3. **[NEW]** Header/Body/Footer separation, with a standardized footer convention.
4. **[EXISTING]** Reuse existing shared CSS classes (`.btn`, `.input`, `.select`, `.field-label`, `.form-grid`) — this guideline does not introduce a new visual theme.

## 3. Master Data Page Anatomy
**[EXISTING, both verified pages share this shape]**
```
<SafePage loading={loading} error={error}>
  [optional standalone info/tip card]
  <Dialog ...>...Add/Edit form...</Dialog>
  <div className="card">
    <h3>Danh sách ...</h3>
    [search input + "+ Thêm ..." button]
    <table>...list with row actions...</table>
    [pagination controls]
  </div>
  [soft-delete confirmation dialog]
</SafePage>
```
`SafePage` (`frontend/src/components/SafePage.jsx`) is the existing, universal loading/error wrapper: shows `"Đang tải..."` while `loading`, an error card + auto-toast when `error` is set, otherwise renders children. **[EXISTING]**

## 4. Dialog Anatomy
**[NEW — Dialog refactor]** `frontend/src/components/common/Dialog.jsx`:
```
.modal-backdrop
  .modal-card.dialog-shell        (only when a standardized footer is used)
    .modal-header                  <- pinned
      <h2>{title}</h2>  [Đóng button]
    .dialog-body                   <- scrolls independently
      {children}
    .modal-footer                  <- pinned
      {Hủy}  {Primary action}
```
When a caller does not pass `primaryAction` (the three pre-existing CreateOrder.jsx POS dialogs), Dialog renders its original, simpler single-scroll body with no shell class — **[EXISTING, unchanged, backward-compatible]**.

## 5. Header Standard
**[EXISTING, unchanged by the Dialog refactor]**
- Dynamic title: `editing ? 'Sửa X' : 'Thêm X'` (or a third variant for scope-limited create, e.g. Customers.jsx's `isCustomer` case).
- Close button (`Đóng`) always present in the header, calls `onClose`.
- Esc closes the dialog — **[NEW — Dialog refactor fixed a real bug here]**: prior to the fix, Esc/backdrop/close could cause the dialog's own inputs to lose focus after every keystroke, because the focus-management effect depended on an inline `onClose` reference that changed on every render. Fixed by holding `onClose` in a ref instead of the effect's dependency array.
- Backdrop-click closes — **[EXISTING]**.
- Focus handling — **[EXISTING]**: on open, focus moves into the dialog card; on close, focus returns to whatever triggered the dialog.

## 6. Body Standard
**[NEW — Dialog refactor]** The body is `flex:1 1 auto; overflow:auto` only when the standardized footer is active (`dialog-shell` class) — so a long form scrolls internally while header/footer stay pinned. **[EXISTING]** content itself (fields, validation, contextual actions) is unchanged from each module's own form.

## 7. Footer Standard
**[NEW — Dialog refactor]**
```jsx
<Dialog
  open={dialogOpen}
  title={editing ? 'Sửa X' : 'Thêm X'}
  onClose={closeDialog}
  primaryAction={{label: editing ? 'Cập nhật' : 'Thêm mới', onClick: save}}
>
  ...body...
</Dialog>
```
Renders `Hủy` (left) and the primary action (right) via `.modal-footer{display:flex;justify-content:space-between}` **[EXISTING CSS rule, reused, not redefined]**. `secondaryAction` is optional and defaults to `onClose`. Footer stays visible while the body scrolls (§6).

**Save/Cancel contract [NEW — Dialog refactor, verified in both Products.jsx and Customers.jsx]:**
- Save closes the dialog **only** inside the success branch of the existing save handler.
- On failure, the dialog stays open, entered values remain (no `reset()` call in the catch branch), and the existing error toast is shown.
- Hủy / Esc / backdrop / header-close all call the same `onClose` handler, which the page wires to its own `reset()`-then-close function — clearing stale edit state before the next open.

## 8. Form Grid
**[EXISTING]** `.form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}` — a simple 2-column responsive grid, used identically in Products.jsx and Customers.jsx, unchanged by the Dialog refactor.

## 9. Field Layout
**[EXISTING]** Each field is typically `<label className="field-label"><span>Label</span><input.../></label>`, one label+control pair per grid cell. `.field-label{display:grid;gap:7px;font-weight:900;color:#334155}`.

## 10. Labels
**[NEW policy, partially existing]** See §39 for the full naming table. Products.jsx and Customers.jsx already use Vietnamese labels consistently; this guideline formalizes the pattern rather than changing it.

## 11. Required Fields
**[NEW policy — not yet applied everywhere]** Verified current behavior: Customers.jsx's "Luồng bán hàng mặc định" field already shows a conditional `*` (`{!editing&&Number(form.partner_type)!==1?' *':''}`) — **[EXISTING, one field only]**. Products.jsx shows no `*` on any field despite `name`, `sales_flow`, and `inventory_mode` all being required by `save()`'s own validation — **[GAP, RECOMMENDED]**: add visible `*` markers to Products.jsx's required fields (Tên mặt hàng, Luồng bán, Chế độ tồn kho) for consistency. Not implemented in this task (would be a presentation change beyond the specific corrections this task authorized).

## 12. Placeholder Policy
**[NEW policy, already followed in practice]** Placeholder = example/format hint, never the only source of the field's name. Verified existing examples: `placeholder="Ví dụ: BO0001"` (Mã hàng), `placeholder="Ví dụ: 120,000"` (Giá bán mặc định) — both already paired with a real `<span>` label, not placeholder-only.

## 13. Help Text
**[EXISTING]** `<p className="muted">...</p>` directly under the dialog title, e.g. Products.jsx: "Hệ thống nhớ mặc định theo user...", Customers.jsx: scope explanation text conditional on `isCustomer`.

## 14. Validation
**[EXISTING, unchanged by this task]** Client-side pre-checks via `showWarning()` before the API call (e.g. Products.jsx: name required, sales_flow required, inventory_mode required, combo-compatibility required); backend remains final authority (`ProductAgent.assertProductClassification`, `CustomerAgent.create/update`) — verified by reading both directly. This guideline does not change any validation rule.

## 15. Error Presentation
**[EXISTING]** `showError(e.response?.data?.message||e.message||'<fallback>')` in every `catch` block — a toast, not an inline field error. No per-field inline error UI exists anywhere in the two verified modules — **NOT_VERIFIED** whether any other screen has one.

## 16. Success Feedback
**[EXISTING]** `showSuccess('<message>')` on the success path, always followed by `reset()` and `load()`/`await load()` to refresh the list.

## 17. Loading/Submitting State
**[EXISTING elsewhere, NOT present in Products.jsx/Customers.jsx main save]**: `SupplierPurchaseOptions.jsx:406` disables its save button via a real `saving` state (`disabled={saving}`) — proving the pattern exists in this codebase. Products.jsx and Customers.jsx's main `save()` functions have **no** such state today (confirmed by direct code read — no `setSaving`/`saving` around either function; only Products.jsx's unrelated category sub-dialog has one). `Dialog.jsx`'s new `submitting` prop is built and ready (**[NEW — Dialog refactor, infrastructure only]**) but **not wired into Products.jsx or Customers.jsx**, since neither has an existing loading state to attach it to and inventing one was out of this task's "presentation relocation only" scope. **[RECOMMENDED]**: add a real `saving` state to both pages' `save()` functions and pass it as `submitting` to Dialog, matching the `SupplierPurchaseOptions.jsx` precedent.

## 18. Input Control Standard
**[EXISTING]** `<input className="input" .../>`. Shared style: `border:1px solid #e5e7eb;border-radius:16px;min-height:44px`, focus ring `box-shadow:0 0 0 3px rgba(26,115,232,.12)`.

## 19. Select Control Standard
**[EXISTING]** `<select className="select">` — same shared visual rule as `.input` (`.input,.select,textarea{...}` one combined CSS rule).

## 20. Textarea Standard
**[EXISTING]** `<textarea className="input" .../>` — reuses the `.input` class directly (confirmed: the delete-reason textareas in both Products.jsx and Customers.jsx use `className="input"`, not a separate `.textarea` class).

## 21. Money/Quantity Input Standard
**[EXISTING]** `<MoneyInput>` (`frontend/src/components/MoneyInput.jsx`) for currency fields (Giá bán, Giá vốn), paired with `data-pos-nav="true" onKeyDown={handlePosInputKeyNavigation}` for grid-style keyboard navigation (`frontend/src/utils/focusNavigation.js`) — verified in Products.jsx. Plain quantity fields (Tồn kho ban đầu, Ngưỡng cảnh báo tồn thấp) use a plain `<input inputMode="decimal">`, same nav helper.

## 22. Checkbox/Switch Standard
**NOT_VERIFIED** — neither Products.jsx nor Customers.jsx uses a checkbox or switch control; boolean-like fields (`is_active`, `allow_negative_stock`) are implemented as two-option `<select>` dropdowns instead (e.g. "Không cho âm kho"/"Cho phép không kiểm tồn"). No dedicated checkbox/switch component was found to document.

## 23. Date/Calendar Input Standard
**[EXISTING, different component]** `frontend/src/components/common/CalendarDialog.jsx` — a separate, hand-rolled modal (not built on `Dialog.jsx`) for Solar/Lunar date entry, used by `CreateOrder.jsx`. Neither Products.jsx nor Customers.jsx currently has a date field in its Add/Edit form — **NOT_VERIFIED** what the intended pattern would be for a future Master Data module needing one; `CalendarDialog.jsx` is the closest existing precedent.

## 24. Search/Filter Standard
**[EXISTING]** A single `<input className="input">` bound to a `search`/`productSearch` state, filtered entirely client-side over the already-loaded `rows` array (confirmed in both files) — not a server-side query, despite backend endpoints accepting a `q` param in some cases (e.g. `GET /products?q=`, unused by `Products.jsx`, which fetches all rows unfiltered).

## 25. Table/List Standard
**[EXISTING]** Plain `<table className="table">`, one `<tr>` per row, action buttons (Sửa/Save/Delete) in a flex row in the last cell, icon-only buttons for row actions (`lucide-react` icons, `size={14}`).

## 26. Pagination Standard
**[EXISTING]** Client-side, `page`/`pageSize` state, `Trước`/`Sau` buttons, a page-size `<select>` (10/20/50/100 or 10/20 depending on the module) — identical implementation duplicated in both files (a `REQUIRES_CTO_DECISION`-worthy future extraction candidate, not undertaken here).

## 27. Primary Button Standard
**[NEW — Dialog refactor]** Exactly one primary (`className="btn"`, solid blue) action per Dialog footer, right-aligned, via `primaryAction`. Label follows each module's existing wording (`Thêm hàng`/`Lưu sửa`, `Thêm đối tác`/`Cập nhật đối tác`) — **[EXISTING wording, NEW placement]**.

## 28. Secondary Button Standard
**[EXISTING class, NEW footer placement]** `className="btn secondary"` (white background, blue border/text). Used for Hủy, and for any non-destructive supporting action (Làm mới, Lấy mã mới, category management triggers).

## 29. Danger Action Standard
**[EXISTING]** `className="btn danger"` (red gradient) — reserved for delete/deactivate actions only (verified: `remove(x)` in both files, `disable(x)` in `SupplierPurchaseOptions.jsx`). Every danger action found requires confirmation first — either the shared `window.appConfirm()` system (`AppDialogHost.jsx`) or a module-specific reason-required dialog (see §31).

## 30. Contextual Action Standard
**[NEW — Dialog refactor]** An action tied to one specific field's meaning must render beside/under that field, never in the generic footer. Verified implementation: "Lấy mã mới" now sits directly under the `Mã khách` input in `Customers.jsx` (previously in the footer actions row, moved this cycle). Products.jsx has no code-generation button — **nothing to relocate there** (verified: no such button exists in that form at all).

## 31. Destructive Confirmation Standard
**[EXISTING, two distinct patterns found]**
1. **Generic:** `window.appConfirm(message, {title, confirmText, cancelText, variant})` → `Promise<boolean>`, rendered by `AppDialogHost.jsx` via `.app-dialog-*` classes, Esc=cancel, Enter=confirm. Used extensively in `CreateOrder.jsx`.
2. **Reason-required:** Products.jsx and Customers.jsx's soft-delete flow does **not** use `window.appConfirm` (which has no text-input capability) — each hand-rolls its own `.app-dialog-backdrop` markup with a required-reason `<textarea autoFocus>`, confirm button disabled while `deleting`. Both patterns reuse the same `.app-dialog-*` CSS.

## 32. Responsive Behavior
**[EXISTING, extended this cycle]** `.modal-card{width:min(1180px,96vw);...}` — width is per-instance via the `maxWidth` prop (Products/Customers use the 520px default; the pre-existing Excel-import modal uses 1180px). **[NEW]** `.dialog-shell` adds `max-height:90vh` normally, `max-height:94vh;width:96vw;padding:14px` under `max-width:640px` — scoped so it never affects the bare `.modal-card` used by `CalendarDialog.jsx`.

## 33. Keyboard Behavior
**[EXISTING, unchanged]** Customers.jsx: `fieldRefs`/`handleFormKey` — Enter/ArrowDown advances to the next field, ArrowUp goes back, Enter on the last field triggers Save. Products.jsx: `data-pos-nav`/`handlePosInputKeyNavigation` on money/quantity fields. Both mechanisms were relocated into the Dialog body verbatim, not modified.

## 34. Focus Behavior
**[NEW — Dialog refactor, bug fix]** See §5 — Esc/focus-restoration now correctly survives every keystroke inside the dialog, root-caused and fixed in `Dialog.jsx` itself (not a per-page workaround).

## 35. Accessibility Expectations
**[EXISTING, partial]** `Dialog.jsx`'s card has `role="dialog" aria-modal="true" aria-label={title}`. Icon-only row-action buttons have a `title` attribute (e.g. `title="Sửa"`) — **[EXISTING]**, functions as a tooltip and an accessible name. **NOT_VERIFIED**: no automated accessibility audit was performed; this is a code-read confirmation only.

## 36. Empty State
**[EXISTING]** `{!filteredRows.length && <tr><td colSpan="6" className="muted">Không tìm thấy mặt hàng phù hợp.</td></tr>}` — one row spanning the table, muted text. Both modules use this pattern.

## 37. Disabled State
**[EXISTING]** `.btn:disabled{...}` (reduced opacity, per the shared CSS rule) — used today for delete-confirm buttons while `deleting`, category-save buttons while `savingCategory`, and (per §17) the `SupplierPurchaseOptions.jsx` save button while `saving`. **Not** currently used on Products.jsx/Customers.jsx's main save button (§17 gap).

## 38. Read-Only State
**NOT_VERIFIED** — no read-only (as opposed to disabled) field pattern was found in either verified module. Category `<select>` becomes `disabled` (not read-only-styled) when its parent condition isn't met (e.g. "Chế độ tồn kho" disabled until "Luồng bán" is chosen) — the only related pattern found.

## 39. Naming and Vietnamese Terminology
**[NEW policy, consolidating EXISTING usage]**

| Concept | Label |
|---|---|
| Product name | Tên mặt hàng |
| Partner name | Tên đối tác |
| Product code | Mã mặt hàng *(current form label: "Mã hàng" — see note)* |
| Partner code | Mã đối tác *(current form label/placeholder: "Mã khách tự động")* |
| Phone | Số điện thoại |
| Address | Địa chỉ |
| Sales flow | Luồng bán |
| Unit | Đơn vị tính |

**Note:** the exact label strings above match the task's preferred pattern; Products.jsx currently says "Mã hàng" (not "Mã mặt hàng") and Customers.jsx uses "Mã khách tự động" as a placeholder rather than a label. Documented here as the target convention — **not retroactively renamed in this task** (renaming existing field labels was not part of the authorized scope this cycle; flagged as a **[RECOMMENDED]** future small patch).

**Terminology rule (binding, already correctly implemented):** the Product list's "Luồng bán" column displays **"Bò xô"** (`CARCASS_POS`) / **"Hàng kho"** (`INVENTORY_SALE`) / **"Chưa xác định"** (null/unknown) — never the short forms "Xô"/"Kho", and never inferred from `inventory_mode`. Verified directly in `Products.jsx`'s `SALES_FLOW_DISPLAY_LABELS` constant. Partner type currently supports exactly **"Khách hàng"** / **"Nhà cung cấp"** — no "Both" option exists in the database, backend, or frontend (verified: `partner_type` is hard-clamped server-side to 1 or 2; do not document a third option as available).

## 40. Code Examples
All examples below are copied/adapted from the actual current codebase, not invented.

**Standard Add/Edit Dialog [NEW]:**
```jsx
<Dialog
  open={itemDialogOpen}
  title={editing ? 'Sửa X' : 'Thêm X'}
  onClose={closeItemDialog}
  primaryAction={{ label: editing ? 'Cập nhật' : 'Thêm mới', onClick: save }}
>
  <div className="form-grid">
    {/* fields */}
  </div>
</Dialog>
```

**`submitting` (infrastructure exists, wire up only if the page has a real loading state) [NEW]:**
```jsx
<Dialog
  ...
  primaryAction={{ label: editing ? 'Cập nhật' : 'Thêm mới', onClick: save, disabled: saving }}
  submitting={saving}
/>
```

**Conditional "Làm mới" — Add mode only [NEW, this task's correction]:**
```jsx
{!editing && (
  <div className="actions" style={{marginTop:12}}>
    <button type="button" className="btn secondary" onClick={reset}>Làm mới</button>
  </div>
)}
```

**Contextual "Lấy mã mới" [NEW, relocated this cycle — Customers.jsx actual code]:**
```jsx
<div style={{display:'flex',flexDirection:'column',gap:6}}>
  <input className="input" placeholder="Mã khách tự động" value={form.customer_code||''} onChange={...}/>
  <button type="button" className="btn tiny secondary" style={{alignSelf:'flex-start'}} onClick={loadNextCode}>Lấy mã mới</button>
</div>
```

**Required field label [RECOMMENDED pattern, one existing example]:**
```jsx
<span>Tên đối tác {!editing ? '*' : ''}</span>
```

**Error display [EXISTING]:**
```jsx
} catch(e) {
  showError(e.response?.data?.message || e.message || 'Lưu thất bại');
}
```

**Confirmation before delete — reason-required variant [EXISTING]:**
```jsx
const ok = await window.appConfirm('Xóa mặt hàng này?', {title:'Xác nhận', variant:'danger'});
if (!ok) return;
```
(Products.jsx/Customers.jsx use their own hand-rolled reason-required dialog instead of this generic one — see §31 — because they need a text input `window.appConfirm` doesn't support.)

**Search plus pagination preservation [EXISTING — this is automatic, not something to implement]:**
No special code is needed: `search`/`page`/`pageSize` state lives in the page component, not the Dialog, so opening/closing/saving the Dialog never touches it. Verified in this task by confirming zero references to that state from any Dialog-related handler.

## 41. Anti-Patterns
Documented from actual mistakes found and corrected during this refactor cycle:
- **Inline `onClose` breaking focus:** passing a fresh arrow function to a component whose effect depends on that prop's identity — caused the sheet-filter-input-loses-focus bug (§5, §34). Fixed at the component level; do not reintroduce a similar effect-dependency pattern in future Dialog-based screens.
- **Generic footer action for a field-specific operation:** "Lấy mã mới" originally sat in the same row as Save/Reset — moved beside its field (§30). Do not place a new code-generation or field-specific action back into the footer.
- **"Làm mới" visible in Edit mode:** clicking it silently abandoned an in-progress edit into a blank Add form, because `reset()` also clears `editing` — corrected this cycle to hide the button (not change `reset()`) while `editing` is set (§ "Làm mới" Decision below).
- **Duplicated pagination/list code:** both Products.jsx and Customers.jsx implement client-side pagination identically, copy-pasted rather than shared — not fixed in this task, flagged as a `REQUIRES_CTO_DECISION` candidate for future extraction.

## 42. Adoption Checklist (for a module already using Dialog)
- [ ] Exactly one `<Dialog>` per Add/Edit workflow, no leftover inline card.
- [ ] `primaryAction` used instead of a hand-rolled footer.
- [ ] Hủy/Esc/backdrop/header-close all route through one `onClose` handler that resets stale state.
- [ ] Save closes the dialog only on success; failure preserves input and shows the existing error mechanism.
- [ ] Contextual actions (code generation, etc.) sit beside their field, not in the footer.
- [ ] "Làm mới" (if present) hidden while editing, visible only in Add mode.
- [ ] No new business validation, API, or payload changes introduced solely for the UI move.

## 43. Migration Checklist (for a module not yet using Dialog)
- [ ] Confirm the module's current Add/Edit form and identify its save/reset/edit handlers — do not rewrite them.
- [ ] Wrap the existing form fields in `<Dialog>`, unchanged internally.
- [ ] Add `primaryAction` wired to the existing save handler.
- [ ] Add `open`/`onClose` state and two thin wrapper handlers (`openAddDialog`, `openEditDialog`) that call the existing `reset()`/`edit()` functions.
- [ ] Relocate any contextual actions (code generation, etc.) beside their field.
- [ ] Audit any "Làm mới"/reset-style button per the decision in this document before relocating it.
- [ ] Verify search/filter/pagination/scroll state is untouched by the new Dialog code.
- [ ] Run the frontend production build; confirm zero errors.

## 44. REQUIRES_CTO_DECISION
- Should Products.jsx's missing required-field asterisks (§11) and label-wording gaps (§39) be corrected in a dedicated small patch?
- Should a real `saving`/`submitting` state be added to Products.jsx/Customers.jsx's save handlers (§17), matching the `SupplierPurchaseOptions.jsx` precedent?
- Should the duplicated client-side pagination logic (§26, §41) be extracted into a shared hook/component?
- Should the two destructive-confirmation patterns (§31) be unified (e.g., extend `window.appConfirm` to optionally support a required-reason text input) rather than maintaining both?

## 45. REQUIRES_CEO_DECISION
None — this document is a presentation/documentation deliverable; it makes no business-data or business-rule decisions.

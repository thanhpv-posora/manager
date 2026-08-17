const UserPermissionAgent = require('../agents/UserPermissionAgent');

// AUTH-SCOPE-001 (Phase 1 authorization foundation): backend-authoritative
// function-permission gate. Reuses UserPermissionAgent.getEffectiveMenus() —
// the exact same source GET /permissions/me already serves to build the
// frontend sidebar — so menu visibility and backend function permission can
// never disagree about what an account may use. No new permission table.
//
// NOT wired into any route in this phase. Requires auth() to have already
// run (reads req.user). Phase 2 will apply this to Nhập Xô routes first.
function requireMenuPermission(menuKey) {
  return async (req, res, next) => {
    try {
      const user = req.user;
      if (!user) return res.status(401).json({ message: 'Chưa đăng nhập' });
      // ADMIN semantics unchanged: UserPermissionAgent.getEffectiveMenus()
      // already returns every active menu for ADMIN with no role-table
      // lookup — no special-case branch needed here to preserve that.
      const effective = await UserPermissionAgent.getEffectiveMenus(user);
      if (!effective.includes(menuKey)) {
        return res.status(403).json({ message: 'Không có quyền sử dụng chức năng này' });
      }
      next();
    } catch (e) {
      next(e);
    }
  };
}

module.exports = { requireMenuPermission };

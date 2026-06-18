# Install MeatBiz Knowledge Platform V1

1. Extract this zip.
2. Copy all files into `D:\thanh\project\manager`.
3. Merge folders if Windows asks.
4. Do not overwrite source code files unless intentional.
5. Commit docs separately:

```bash
git add MEATBIZ.md docs .claude README_INSTALL.md
git commit -m "docs: add MeatBiz Knowledge Platform V1"
```

## First Claude Task

Start a new Claude session:

```cmd
cd /d D:\thanh\project\manager
claude
```

Then run:

```text
Read .claude/prompts/task_001_business_governance.md and execute it.
```

Use one task per Claude session.

# MeatBiz Deployment Bible V1

## Production Rules

- Environment variables must be explicit.
- Missing secrets must stop startup.
- Database credentials must not be reused across environments.
- Logs must rotate.
- Backup and restore must be tested.
- Docker builds must not include secrets.

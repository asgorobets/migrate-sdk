# Testing

## SQL provider smoke tests

With Docker and Docker Compose running, execute:

```sh
pnpm test:sql:smoke
```

The command starts PostgreSQL, MySQL, and SQL Server, waits for them to become
ready, then runs the SQL Migration Store checks and end-to-end CLI migrations
through a real SQL source, store, and destination. Containers and volumes are
removed afterward.

The first run downloads the database images. On Apple Silicon, SQL Server runs
through `linux/amd64` emulation and may take longer to start.

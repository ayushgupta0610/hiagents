// PM2 process manifest for hiagents.
//
// Deploy / restart:
//   pm2 start ecosystem.config.cjs             # first time
//   pm2 restart hiagents                       # after pulling new code
//   pm2 logs hiagents                          # live tail logs
//   pm2 monit                                  # interactive dashboard
//   pm2 save && pm2 startup                    # persist across reboots
//
// Multi-client on same VPS: copy this file into each client's directory
// and override `name` + `PORT` so PM2 sees them as distinct apps.

module.exports = {
  apps: [
    {
      name: 'hiagents',
      script: 'dist/server.js',
      // Run from the directory containing this file
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      // App reads .env via dotenv at startup; we just set NODE_ENV here.
      // Override PORT here per-client if running multiple hiagents instances
      // on the same VPS behind nginx (e.g. PORT: 3001 for client A, 3002 for B).
      env: {
        NODE_ENV: 'production',
      },
      // Restart if memory ever creeps; embeddings + PDFs can be heap-heavy
      max_memory_restart: '768M',
      // Wait 5s after exit before respawning to avoid tight loops
      restart_delay: 5000,
      // Hard kill ceiling. Must be > server.ts SHUTDOWN_TIMEOUT_MS (15000)
      // so the graceful drain completes before pm2 escalates to SIGKILL.
      kill_timeout: 20000,
      // PM2 will buffer logs to disk and rotate via pm2-logrotate if installed
      out_file: './logs/out.log',
      error_file: './logs/error.log',
      merge_logs: true,
      time: true,
    },
  ],
};

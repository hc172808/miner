// PM2 ecosystem config — auto-restarts the miner on crash or reboot.
//
// Usage:
//   npm install -g pm2          # install PM2 once
//   pm2 start ecosystem.config.js
//   pm2 save                    # persist across reboots
//   pm2 startup                 # generate OS startup hook
//
// Useful commands:
//   pm2 status                  # see all processes
//   pm2 logs gyds-miner         # live log tail
//   pm2 restart gyds-miner      # rolling restart
//   pm2 stop gyds-miner         # stop without removing
//   pm2 delete gyds-miner       # remove from PM2

module.exports = {
  apps: [
    {
      name:         'gyds-miner',
      script:       'miner.js',
      cwd:          __dirname,

      // Restart policy
      autorestart:  true,
      watch:        false,           // don't restart on file changes (use update.sh)
      max_restarts: 10,              // give up after 10 rapid crashes
      min_uptime:   '10s',          // a restart counts only if it stays up ≥ 10 s
      restart_delay: 3000,          // wait 3 s between restarts

      // Logging
      out_file:   './logs/pm2-out.log',
      error_file: './logs/pm2-err.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      max_size:   '10M',            // rotate when log exceeds 10 MB

      // Environment
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};

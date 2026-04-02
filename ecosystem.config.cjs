module.exports = {
  apps: [
    {
      name: 'happyclaw',
      script: 'dist/index.js',
      cwd: __dirname,
      env: {
        NODE_ENV: 'production',
        ...(process.env.DOCKER_HOST
          ? { DOCKER_HOST: process.env.DOCKER_HOST }
          : { DOCKER_HOST: `unix://${process.env.HOME}/.colima/default/docker.sock` }),
      },
      // 自恢复配置
      autorestart: true,
      max_restarts: 15, // 15 分钟窗口内最多重启 15 次，超过则停止（避免端口占用时疯狂重启）
      min_uptime: 10000, // 进程存活不足 10 秒视为异常重启（计入 max_restarts）
      restart_delay: 3000, // 崩溃后等 3 秒再重启
      exp_backoff_restart_delay: 100, // 指数退避（100ms 起步，最大 15s）

      // 内存阈值重启（可选，防止内存泄漏）
      max_memory_restart: '1G',

      // 日志
      error_file: 'data/logs/pm2-error.log',
      out_file: 'data/logs/pm2-out.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',

      // 优雅关闭
      kill_timeout: 15000,
      listen_timeout: 10000,
      shutdown_with_message: true,
    },
  ],
};

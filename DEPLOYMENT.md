# Afterword 私人部署与发布检查

本项目面向**一个人的词库**，电脑与 Pad 连接同一服务，共享词库和一组学习进度。不是多租户 SaaS；没有注册、多人数据隔离、找回密码、MFA 或水平扩容。不要将访问密码分享给不应查看或修改词库的人。未完成下列发布检查前，不应宣称已经完成生产上线。

## 1. 两种运行方式

- 本机模式：`npm start`，监听 `127.0.0.1`，无登录，继续兼容现有用法。**禁止把该模式直接反向代理到公网。**
- 私人远程模式：同时配置 `AFTERWORD_PUBLIC_ORIGIN` 和 `AFTERWORD_PASSWORD_HASH`，由受信任的反向代理提供 HTTPS。电脑与 Pad 使用相同 HTTPS 地址。配置缺失、HTTP origin、错误密码摘要或无认证的 `HOST=0.0.0.0` 都会拒绝启动。

Node 服务不自行签发证书，不信任 `X-Forwarded-Host` 或 `X-Forwarded-For`。代理必须原样传递配置域名的 Host，API 写请求的 Origin 必须精确匹配配置值。API 客户端也需要登录 Cookie 与 Origin；不要为了兼容脚本删除这些检查。

## 2. 配置访问密码

使用 Node.js 24 LTS，或项目支持的 Node.js 22.13+。在项目目录执行：

```sh
npm run password:hash
```

终端会隐藏密码输入并要求再次确认。密码至少 12 字符，最多 256 字节，使用 scrypt（N=131072、r=8、p=1）和独立随机盐。为密码验证与应用运行至少预留 512 MB 内存。将输出的 `AFTERWORD_PASSWORD_HASH='scrypt$…'` 整行放入 `.env`，**保留单引号**，不要把明文密码写入命令行、仓库或截图。

`.env` 示例（域名换成你自己的）：

```dotenv
AFTERWORD_PUBLIC_ORIGIN=https://words.example.com
AFTERWORD_PASSWORD_HASH='此处替换为生成的完整 scrypt 摘要'
LLM_ENABLED=false
```

origin 不带路径、末尾斜线、查询参数或账号信息。`.env` 不参与 Git 或镜像构建。限制该文件读取权限；备份本身也包含私人词库，不要提交或公开分享。

## 3. 容器与 HTTPS

在已经安装 Docker Compose 的服务器上：

```sh
docker compose up -d --build
docker compose ps
```

容器使用非 root 用户、只读根文件系统、数据卷和最小权限；端口只发布到宿主机 `127.0.0.1:3210`。Compose 数据保存在 `afterword-data` 命名卷，**不会自动使用开发电脑的 `data/`**。迁移已有数据时，在网页导出 JSON，并在部署后的“偏好与备份”恢复。不要使用 `docker compose down -v`，它会删除数据卷。

用 `Caddyfile.example` 配置**宿主机上的 Caddy**，替换域名，确保 DNS 指向服务器且 80/443 可用。Caddy 代理到 `127.0.0.1:3210` 并负责 HTTPS。该模板不适用于隔离容器中的 Caddy，因为其 loopback 不是宿主机。也可使用其他 HTTPS 代理，但必须保留 Host、不缓存 API/登录响应，并设置 30 MB 请求上限与至少 150 秒上游响应超时。

只开放代理的 80/443，不直接开放 Node 端口。应用登录会话为服务端随机令牌，Cookie 使用 `Secure`、`HttpOnly`、`SameSite=Strict`、`__Host-` 前缀；最长 12 小时、闲置 1 小时失效。进程重启后需重新登录，学习进度仍在数据库中。相关设计参考 [OWASP 会话管理指南](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)。

登录请求全实例每分钟最多 5 次，同时只验证一个密码，不信任来源 IP 转发头。小规模私人部署可用；面向广泛用户开放前，应引入成熟身份服务、反向代理限流与独立安全评审。不要通过多开实例绕过限制。

## 4. 备份与恢复演练

本机运行中也可以创建一致性 JSON 快照：

```sh
npm run backup
npm run backup -- /你的独立备份目录
```

容器内：

```sh
docker compose exec afterword npm run backup
```

输出 JSON 包含实际文件路径与条数。备份在事务中读取、通过格式校验、写临时文件后原子重命名，权限为 `0600`，不覆盖旧快照；默认位于数据库旁的 `backups/`。数据库不存在时拒绝生成空备份。它不会自动清理历史快照，也不会自动上传异地；自行安排每日执行、异地加密复制与磁盘容量监控。

**备份文件留在同一块磁盘并不等于灾备。** 发布前将备份复制到另一台机器，在独立实例里通过“恢复备份”确认词条、笔记、偏好、未完成学习组均一致。不要在服务运行时只复制 SQLite 主文件，WAL 可能含尚未合并的数据。不要为了测试覆盖正式词库。

## 5. 发布和回滚

1. 运行 `npm run check`、`npm test`，确认 GitHub Node 22/24 测试与容器 smoke test 成功。
2. 备份当前数据，并做一次独立恢复演练；记录 Git 提交号和镜像标识。
3. 先在独立数据卷验证新版本，再更新正式实例。
4. 检查 `https://你的域名/healthz` 返回 `{"status":"ok"}`；它只报告存活与数据库查询，不返回词库、路径或密钥。
5. 未登录访问 `/api/backup` 必须返回 401；跨站写请求必须返回 403。验证真实 HTTPS 下 Cookie 的安全属性、登录、退出、重新登录及 Pad Safari 的页面和语音能力。
6. 验证新词完整一组、纠错、刷新续学、导入预览不落库、确认保存和 JSON 备份。
7. 如需回滚代码，先核对数据库版本兼容性。更新版本的数据库会拒绝被旧格式代码打开；不要强改 `user_version`。有数据迁移时从发布前快照恢复到独立实例验证，再人工切换流量。

退出码非零、健康检查失败或备份失败都应触发运维告警。请求响应含 `X-Request-Id`；未知异常只记录请求编号和异常类型，不输出正文、密码、API key 或上游报错。服务停止会等待请求完成，最长 150 秒后强制退出；Compose 预留 160 秒。

## 当前验证边界

自动测试覆盖 Host/Origin、防未登录读写、Cookie 轮换与撤销、过期、限流、超大请求、备份恢复和旧库拒绝降级。CI 构建容器并做 HTTP smoke test。仍须由真实服务器验证域名、证书、防火墙、异地恢复、持续监控以及 iPad 真机 Safari。本地接口测试不等同于这些基础设施已经部署完毕。

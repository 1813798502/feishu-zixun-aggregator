# 信息聚合 -> AI 整理 -> 飞书发送（Cloudflare Worker）

一个可直接部署到 Cloudflare Worker 的信息聚合工具：

- 多来源抓取热点/资讯
- 调用兼容 OpenAI 的 AI 接口做结构化整理
- 一键发送到飞书群
- 支持 Cron 定时自动执行
- 支持手动触发一次定时任务（便于联调）

## 功能特性

- 来源抓取：知乎、百度、头条、腾讯新闻、Linux.do、V2EX、华尔街见闻等
- AI 整理：支持非流式 + 流式 fallback（兼容更多网关）
- 飞书发送：`post` 富文本 / `text` 纯文本
- 前端页面：可在 Worker 首页直接操作
- 定时任务：Worker `scheduled` 入口自动跑全流程
- 调试能力：`/api/run-scheduled` 手动触发定时流程

## 项目结构

```text
.
├─ worker.js          # 主 Worker（页面 + API + 定时任务）
```

## 快速开始

### 1. 准备

- Cloudflare 账号
- 飞书应用（用于发送群消息）
- 一个可用的兼容 OpenAI 的 AI 接口

### 2. 部署 Worker

本项目就是单文件 `worker.js`，可直接在 Cloudflare 控制台粘贴部署：

1. 打开 Cloudflare 控制台 -> Workers & Pages -> Create -> Worker
2. 进入代码编辑器，删除默认模板代码
3. 把仓库里的 `worker.js` 全量粘贴进去
4. 点击 Save and Deploy
5. 访问分配的 `*.workers.dev` 域名，能打开页面即部署成功

### 3. 配置环境变量

在 Worker -> Settings -> Variables and Secrets 中添加本文下方变量。

注意：

- `FEISHU_APP_SECRET`、`AUTO_RUN_AI_API_KEY` 建议放 Secret
- 其他可放普通变量

### 4. 配置 Cron Trigger

在 Worker -> Settings -> Triggers -> Cron Triggers -> Add cron trigger 中添加表达式。

示例：

- 每天北京时间 09:00：`0 1 * * *`
- 每天北京时间 09:00 和 21:00：`0 1,13 * * *`

保存后会自动生效；如果不放心可再点一次 Deploy。

## 环境变量（Cloudflare Worker Variables & Secrets）

### 必填

- `FEISHU_APP_ID`
- `FEISHU_APP_SECRET`
- `DEFAULT_CHAT_ID`（默认发送群）
- `AUTO_RUN_AI_API_URL`（兼容 OpenAI 的 chat completions 地址）
- `AUTO_RUN_AI_API_KEY`
- `AUTO_RUN_AI_MODEL`

### 推荐

- `WORKER_TOKEN`（开启接口鉴权）
- `AUTO_RUN_ENABLED=true`
- `AUTO_RUN_SOURCES=zhihu,baidu,toutiao,linuxdo,v2ex`
- `AUTO_RUN_LIMIT_PER_SOURCE=8`
- `AUTO_RUN_MAX_ITEMS=20`
- `AUTO_RUN_MESSAGE_MODE=post`（可选 `text`）
- `AUTO_RUN_AI_SYSTEM_PROMPT`（不填则使用内置提示词）
- `AUTO_RUN_TITLE` / `AUTO_RUN_INTRO` / `AUTO_RUN_FOOTER`（可选）

## 使用方式

### Web 页面

部署后访问 Worker 根路径 `/`：

1. 输入 `WORKER_TOKEN`（如果你配置了）
2. 刷新飞书群列表
3. 抓取来源 -> AI 整理 -> 发送
4. 也可点“手动触发一次定时任务”

### 手动触发定时流程（API）

- 路径：`POST /api/run-scheduled`
- 鉴权：`x-worker-token: <WORKER_TOKEN>`（若配置）

示例：

```bash
curl -X POST "https://<your-worker>.workers.dev/api/run-scheduled" \
  -H "x-worker-token: <WORKER_TOKEN>"
```

## Cron Trigger 配置

Cloudflare Cron 使用 UTC。

北京时间 = UTC + 8，所以表达式要减 8 小时。

常用示例：

- 每天北京时间 09:00：`0 1 * * *`
- 每天北京时间 09:00 和 21:00：`0 1,13 * * *`
- 工作日北京时间 09:00：`0 1 * * 1-5`
- 每 2 小时整点：`0 */2 * * *`

## API 概览

- `GET /` 页面
- `GET /api/chats` 获取飞书群列表
- `POST /api/fetch-sources` 抓取来源
- `POST /api/ai-organize` AI 整理
- `POST /api/send-aggregate` 发送飞书
- `POST /api/run-scheduled` 手动触发定时流程

## 常见问题

### 1) 我设了 20 条，为什么只返回更少？

可能原因：

- 模型本次只生成了更少条目
- 原始内容不足以支撑更多条目
- 你本地页面缓存了旧提示词（localStorage）

可检查：

- 确认 `AUTO_RUN_MAX_ITEMS` 或 `max_items` 参数
- 清理浏览器草稿缓存后重试

### 2) AI 接口兼容性问题（content 为空）

项目已做非流式优先 + 流式 fallback 解析，兼容更多 OpenAI 网关实现。

## 安全说明

- 强烈建议配置 `WORKER_TOKEN`
- 不要提交真实密钥到仓库
- 若密钥曾出现在截图/日志中，请立刻轮换

## License

本项目使用 MIT License。

const DEFAULT_AI_SYSTEM_PROMPT = `
你是一个“信息聚合整理助手”。

你的任务是把用户提供的原始内容整理成适合发送到飞书群的结构化摘要。

请严格只返回 JSON，不要返回 markdown，不要返回解释，不要返回代码块。

返回格式必须是：
{
  "title": "聚合标题",
  "intro": "导语",
  "items": [
    {
      "title": "条目标题",
      "summary": "条目摘要",
      "link": "https://example.com"
    }
  ],
  "footer": "结尾说明"
}

要求：
1. 必须返回合法 JSON
2. items 最多 20 条
3. 没有链接时 link 返回空字符串
4. 每条 summary 尽量精炼
5. title、intro、footer 没有内容也要返回空字符串
6. 不要输出 JSON 之外的任何字符
`.trim();

const DEFAULT_MAX_AGGREGATE_ITEMS = 20;

const SOURCE_META = [
  { id: "zhihu", name: "知乎热榜" },
  { id: "baidu", name: "百度热榜" },
  { id: "toutiao", name: "今日头条热榜" },
  { id: "tencent-hot", name: "腾讯新闻热榜" },
  { id: "linuxdo", name: "Linux.do 最新" },
  { id: "linuxdo-hot", name: "Linux.do 日榜" },
  { id: "v2ex", name: "V2EX" },
  { id: "wallstreetcn", name: "华尔街见闻快讯" },
  { id: "wallstreetcn-news", name: "华尔街见闻资讯" },
  { id: "wallstreetcn-hot", name: "华尔街见闻热门" }
];

const SOURCE_NAME_MAP = Object.fromEntries(
  SOURCE_META.map((x) => [x.id, x.name])
);

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function html(content, status = 200) {
  return new Response(content, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function getRequestToken(request, url) {
  return (
    request.headers.get("x-worker-token") ||
    url.searchParams.get("token") ||
    ""
  ).trim();
}

function isAuthed(request, url, env) {
  if (!env.WORKER_TOKEN) return true;
  return getRequestToken(request, url) === env.WORKER_TOKEN;
}

function requireAuth(request, url, env) {
  if (!isAuthed(request, url, env)) {
    return json({ ok: false, error: "Unauthorized" }, 401);
  }
  return null;
}

async function fetchJson(url, init) {
  const resp = await fetch(url, init);
  const text = await resp.text();
  let data = {};

  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`接口未返回 JSON: ${url}\n${text.slice(0, 500)}`);
  }

  if (!resp.ok) {
    throw new Error(`请求失败 ${resp.status}: ${url}\n${JSON.stringify(data).slice(0, 500)}`);
  }

  return data;
}

async function fetchText(url, init) {
  const resp = await fetch(url, init);
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`请求失败 ${resp.status}: ${url}\n${text.slice(0, 500)}`);
  }
  return text;
}

function normalizeSourceItems(items) {
  return (Array.isArray(items) ? items : [])
    .map((item) => ({
      id: String(item && (item.id || item.url || item.title || "")).trim(),
      title: String(item && item.title || "").trim(),
      url: String(item && item.url || "").trim(),
      mobileUrl: item && item.mobileUrl ? String(item.mobileUrl) : undefined,
      pubDate: item && item.pubDate,
      extra: item && item.extra ? item.extra : {}
    }))
    .filter((item) => item.id && item.title && item.url);
}

function mergeNews(items) {
  const map = new Map();

  for (const item of items) {
    const key = item.url || item.id || item.title;
    if (!map.has(key)) map.set(key, item);
  }

  return Array.from(map.values()).sort((a, b) => {
    const ta = Number(a.pubDate || 0);
    const tb = Number(b.pubDate || 0);
    return tb - ta;
  });
}

function buildRawTextFromSources(groups) {
  const lines = [];

  for (const group of groups) {
    lines.push(`## 来源：${SOURCE_NAME_MAP[group.source] || group.source}`);
    lines.push("");

    group.items.forEach((item, idx) => {
      lines.push(`${idx + 1}. ${item.title}`);
      if (item.extra && item.extra.info) lines.push(`信息：${item.extra.info}`);
      if (item.extra && item.extra.hover) lines.push(`摘要：${item.extra.hover}`);
      if (item.pubDate) lines.push(`时间：${item.pubDate}`);
      lines.push(`链接：${item.url}`);
      lines.push("");
    });

    lines.push("");
  }

  return lines.join("\n").trim();
}

async function fetchZhihu() {
  const url = "https://www.zhihu.com/api/v3/feed/topstory/hot-list-web?limit=20&desktop=true";
  const res = await fetchJson(url);
  return normalizeSourceItems(
    (res && res.data || []).map((k) => ({
      id: k && k.target && k.target.link && k.target.link.url
        ? (k.target.link.url.match(/(\d+)$/) || [])[1] || k.target.link.url
        : "",
      title: k && k.target && k.target.title_area ? k.target.title_area.text : "",
      url: k && k.target && k.target.link ? k.target.link.url : "",
      extra: {
        info: k && k.target && k.target.metrics_area ? k.target.metrics_area.text : "",
        hover: k && k.target && k.target.excerpt_area ? k.target.excerpt_area.text : ""
      }
    }))
  );
}

async function fetchBaidu() {
  const raw = await fetchText("https://top.baidu.com/board?tab=realtime");
  const m = raw.match(/<!--s-data:(.*?)-->/s);
  if (!m || !m[1]) return [];
  const data = JSON.parse(m[1]);
  return normalizeSourceItems(
    (((data || {}).data || {}).cards || [])[0]?.content
      ?.filter((k) => !k.isTop)
      .map((k) => ({
        id: k.rawUrl,
        title: k.word,
        url: k.rawUrl,
        extra: {
          hover: k.desc || ""
        }
      })) || []
  );
}

async function fetchToutiao() {
  const url = "https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc";
  const res = await fetchJson(url);
  return normalizeSourceItems(
    (res && res.data || []).map((k) => ({
      id: k.ClusterIdStr,
      title: k.Title,
      url: `https://www.toutiao.com/trending/${k.ClusterIdStr}/`,
      extra: {
        info: k.HotValue ? `热度：${k.HotValue}` : ""
      }
    }))
  );
}

async function fetchTencentHot() {
  const url = "https://i.news.qq.com/web_backend/v2/getTagInfo?tagId=aEWqxLtdgmQ%3D";
  const res = await fetchJson(url, {
    headers: {
      Referer: "https://news.qq.com/"
    }
  });
  return normalizeSourceItems(
    ((((res || {}).data || {}).tabs || [])[0]?.articleList || []).map((news) => ({
      id: String(news.id),
      title: news.title,
      url: news && news.link_info ? news.link_info.url || "" : "",
      extra: {
        hover: news.desc || ""
      }
    }))
  );
}

async function fetchLinuxdoLatest() {
  const res = await fetchJson("https://linux.do/latest.json?order=created");
  return normalizeSourceItems(
    (((res || {}).topic_list || {}).topics || [])
      .filter((k) => k.visible && !k.archived && !k.pinned)
      .map((k) => ({
        id: String(k.id),
        title: k.title,
        url: `https://linux.do/t/topic/${k.id}`,
        pubDate: new Date(k.created_at).valueOf()
      }))
  );
}

async function fetchLinuxdoHot() {
  const res = await fetchJson("https://linux.do/top/daily.json");
  return normalizeSourceItems(
    (((res || {}).topic_list || {}).topics || [])
      .filter((k) => k.visible && !k.archived && !k.pinned)
      .map((k) => ({
        id: String(k.id),
        title: k.title,
        url: `https://linux.do/t/topic/${k.id}`
      }))
  );
}

async function fetchV2EX() {
  const feeds = ["create", "ideas", "programmer", "share"];
  const resList = await Promise.all(
    feeds.map((k) => fetchJson(`https://www.v2ex.com/feed/${k}.json`))
  );

  return mergeNews(
    normalizeSourceItems(
      resList
        .map((r) => r.items || [])
        .flat()
        .map((k) => ({
          id: k.id,
          title: k.title,
          url: k.url,
          pubDate: new Date(k.date_modified || k.date_published || Date.now()).valueOf(),
          extra: {
            hover: ""
          }
        }))
    )
  );
}

async function fetchWallstreetcnLive() {
  const url = "https://api-one.wallstcn.com/apiv1/content/lives?channel=global-channel&limit=30";
  const res = await fetchJson(url);
  return normalizeSourceItems(
    ((((res || {}).data || {}).items) || []).map((k) => ({
      id: String(k.id),
      title: k.title || k.content_text,
      url: k.uri,
      pubDate: Number(k.display_time) * 1000
    }))
  );
}

async function fetchWallstreetcnNews() {
  const url = "https://api-one.wallstcn.com/apiv1/content/information-flow?channel=global-channel&accept=article&limit=30";
  const res = await fetchJson(url);
  return normalizeSourceItems(
    ((((res || {}).data || {}).items) || [])
      .filter(
        (k) =>
          k.resource_type !== "theme" &&
          k.resource_type !== "ad" &&
          (!k.resource || k.resource.type !== "live") &&
          k.resource &&
          k.resource.uri
      )
      .map((k) => ({
        id: String(k.resource.id),
        title: k.resource.title || k.resource.content_short,
        url: k.resource.uri,
        pubDate: Number(k.resource.display_time) * 1000
      }))
  );
}

async function fetchWallstreetcnHot() {
  const url = "https://api-one.wallstcn.com/apiv1/content/articles/hot?period=all";
  const res = await fetchJson(url);
  return normalizeSourceItems(
    ((((res || {}).data || {}).day_items) || []).map((k) => ({
      id: String(k.id),
      title: k.title || k.content_short,
      url: k.uri
    }))
  );
}

const SOURCES = {
  zhihu: fetchZhihu,
  baidu: fetchBaidu,
  toutiao: fetchToutiao,
  "tencent-hot": fetchTencentHot,
  linuxdo: fetchLinuxdoLatest,
  "linuxdo-hot": fetchLinuxdoHot,
  v2ex: fetchV2EX,
  wallstreetcn: fetchWallstreetcnLive,
  "wallstreetcn-news": fetchWallstreetcnNews,
  "wallstreetcn-hot": fetchWallstreetcnHot
};

async function getTenantAccessToken(env) {
  if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET) {
    throw new Error("未配置 FEISHU_APP_ID 或 FEISHU_APP_SECRET");
  }

  const resp = await fetch(
    "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
    {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8"
      },
      body: JSON.stringify({
        app_id: env.FEISHU_APP_ID,
        app_secret: env.FEISHU_APP_SECRET
      })
    }
  );

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || data.code !== 0 || !data.tenant_access_token) {
    throw new Error("获取 tenant_access_token 失败: " + JSON.stringify(data));
  }
  return data.tenant_access_token;
}

async function listChats(env) {
  const token = await getTenantAccessToken(env);
  const resp = await fetch("https://open.feishu.cn/open-apis/im/v1/chats?page_size=100", {
    method: "GET",
    headers: {
      Authorization: "Bearer " + token
    }
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || data.code !== 0) {
    throw new Error("获取群列表失败: " + JSON.stringify(data));
  }

  const items = (data.data?.items || []).map((item) => ({
    name: item.name || "",
    chat_id: item.chat_id || "",
    description: item.description || "",
    avatar: item.avatar || "",
    external: !!item.external
  }));

  return { ok: true, total: items.length, items };
}

async function sendFeishuMessage(env, chatId, msgType, content) {
  const token = await getTenantAccessToken(env);
  const resp = await fetch(
    "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id",
    {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "content-type": "application/json; charset=utf-8"
      },
      body: JSON.stringify({
        receive_id: chatId,
        msg_type: msgType,
        content
      })
    }
  );

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || data.code !== 0) {
    throw new Error("发送消息失败: " + JSON.stringify(data));
  }

  return data;
}

function normalizeAggregateItems(items, max = 20) {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => ({
      title: String(item && item.title || "").trim(),
      link: String(item && item.link || "").trim(),
      summary: String(item && item.summary || "").trim()
    }))
    .filter((item) => item.title || item.link || item.summary)
    .slice(0, max);
}

function resolveMaxAggregateItems(value, fallback = DEFAULT_MAX_AGGREGATE_ITEMS) {
  return Math.min(Math.max(Number(value || fallback), 1), 50);
}

function buildPreviewText(payload) {
  const lines = [];
  const finalTitle = (payload.title || "信息聚合").trim();

  lines.push("【" + finalTitle + "】");
  if (payload.intro) lines.push(payload.intro.trim());

  payload.items.forEach((item, index) => {
    lines.push("");
    lines.push(index + 1 + ". " + (item.title || "未命名条目"));
    if (item.summary) lines.push("摘要：" + item.summary);
    if (item.link) lines.push("链接：" + item.link);
  });

  if (payload.footer) {
    lines.push("");
    lines.push(payload.footer.trim());
  }

  return lines.join("\n").trim();
}

function buildTextMessage(payload) {
  const preview = buildPreviewText(payload);
  return {
    msg_type: "text",
    content: JSON.stringify({ text: preview }),
    preview
  };
}

function buildPostMessage(payload) {
  const title = (payload.title || "信息聚合").trim();
  const intro = (payload.intro || "").trim();
  const footer = (payload.footer || "").trim();
  const items = payload.items || [];
  const content = [];

  if (intro) content.push([{ tag: "text", text: intro }]);

  items.forEach((item, index) => {
    content.push([{ tag: "text", text: index + 1 + ". " + (item.title || "未命名条目") }]);

    const detailRow = [];
    if (item.summary) {
      detailRow.push({ tag: "text", text: "摘要：" + item.summary + " " });
    }
    if (item.link) {
      detailRow.push({ tag: "a", text: "查看链接", href: item.link });
    }
    if (detailRow.length > 0) content.push(detailRow);
  });

  if (footer) content.push([{ tag: "text", text: footer }]);

  return {
    msg_type: "post",
    content: JSON.stringify({
      zh_cn: {
        title,
        content
      }
    }),
    preview: buildPreviewText(payload)
  };
}

function extractJsonText(text) {
  const raw = String(text || "").trim();
  if (!raw) return "";

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced) return fenced[1].trim();

  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    return raw.slice(start, end + 1);
  }

  return raw;
}

function parseAiJson(text) {
  const jsonText = extractJsonText(text);
  try {
    return JSON.parse(jsonText);
  } catch {
    throw new Error("AI 返回的内容不是合法 JSON: " + jsonText.slice(0, 1000));
  }
}

function extractTextFromContent(content) {
  if (!content) return "";

  if (typeof content === "string") {
    return content.trim();
  }

  if (typeof content === "object") {
    const directText =
      content.text ||
      content.content ||
      content.output_text ||
      content.value ||
      "";

    if (typeof directText === "string" && directText.trim()) {
      return directText.trim();
    }
  }

  if (Array.isArray(content)) {
    const text = content
      .map((part) => {
        if (!part) return "";
        if (typeof part === "string") return part;

        const partText =
          part.text ||
          part.content ||
          part.output_text ||
          part.value ||
          "";

        if (typeof partText === "string") return partText;

        if (partText && typeof partText === "object") {
          return partText.text || partText.value || "";
        }

        return (
          (part.text && part.text.text) ||
          (part.content && part.content.text) ||
          ""
        );
      })
      .join("")
      .trim();

    if (text) return text;
  }

  return "";
}

async function readStreamText(resp) {
  if (!resp.body) return "";

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finalText = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    buffer = buffer.replace(/\r\n/g, "\n");

    let index = -1;
    while ((index = buffer.indexOf("\n\n")) >= 0) {
      const chunk = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);

      const lines = chunk.split("\n");
      const dataLines = lines
        .map((line) => line.trim())
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .filter(Boolean);

      if (!dataLines.length) continue;

      const dataStr = dataLines.join("\n");
      if (dataStr === "[DONE]") continue;

      try {
        const data = JSON.parse(dataStr);
        const delta = data?.choices?.[0]?.delta || {};

        const deltaText = extractTextFromContent(delta.content);
        if (deltaText) finalText += deltaText;

        const toolCalls = delta?.tool_calls;
        if (Array.isArray(toolCalls)) {
          for (const tool of toolCalls) {
            const args = tool?.function?.arguments;
            if (typeof args === "string") finalText += args;
          }
        }
      } catch {
        // 忽略非 JSON 的 SSE 片段
      }
    }
  }

  return finalText.trim();
}

function readAiMessageText(data) {
  try {
    const choice = data?.choices?.[0] || {};
    const message = choice?.message || {};

    // 1) 最常见
    let text = extractTextFromContent(message.content);
    if (text) return text;

    // 2) OpenAI 兼容扩展字段
    text = extractTextFromContent(message.output_text);
    if (text) return text;

    text = extractTextFromContent(message.text);
    if (text) return text;

    text = extractTextFromContent(choice.text);
    if (text) return text;

    text = extractTextFromContent(data.output_text);
    if (text) return text;

    text = extractTextFromContent(data.text);
    if (text) return text;

    text = extractTextFromContent(data.content);
    if (text) return text;

    text = extractTextFromContent(data.response);
    if (text) return text;

    // 3) function_call / tool_calls
    const functionArgs = message?.function_call?.arguments;
    if (typeof functionArgs === "string" && functionArgs.trim()) {
      return functionArgs.trim();
    }

    const toolCalls = message?.tool_calls;
    if (Array.isArray(toolCalls) && toolCalls.length > 0) {
      const toolText = toolCalls
        .map((t) => t?.function?.arguments || "")
        .join("\n")
        .trim();

      if (toolText) return toolText;
    }

    // 4) 新一点的 output 结构
    const output = data?.output;
    if (Array.isArray(output)) {
      const outText = output
        .map((item) => {
          if (!item) return "";
          if (typeof item === "string") return item;

          if (Array.isArray(item.content)) {
            return item.content
              .map((c) => c?.text || c?.content || "")
              .join("");
          }

          return item.text || item.content || "";
        })
        .join("")
        .trim();

      if (outText) return outText;
    }

    return "";
  } catch {
    return "";
  }
}

async function callAiApi(input) {
  const headers = {
    Authorization: "Bearer " + input.aiApiKey,
    "content-type": "application/json; charset=utf-8"
  };

  const messages = [
    { role: "system", content: input.systemPrompt || DEFAULT_AI_SYSTEM_PROMPT },
    { role: "user", content: "请将下面内容整理成指定 JSON：\n\n" + input.rawText }
  ];

  const requestBody = {
    model: input.aiModel,
    temperature: 0.2,
    max_tokens: 2000000,
    response_format: { type: "json_object" },
    messages
  };

  const normalResp = await fetch(input.aiApiUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({
      stream: false,
      ...requestBody
    })
  });

  const normalRawText = await normalResp.text();
  let data = {};

  try {
    data = normalRawText ? JSON.parse(normalRawText) : {};
  } catch {
    throw new Error("AI 接口返回的不是 JSON: " + normalRawText.slice(0, 1000));
  }

  if (!normalResp.ok) {
    throw new Error("AI 接口调用失败: " + JSON.stringify(data));
  }

  const text = readAiMessageText(data);
  if (text) {
    return {
      raw: data,
      text,
      mode: "json"
    };
  }

  const streamResp = await fetch(input.aiApiUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({
      stream: true,
      ...requestBody
    })
  });

  if (!streamResp.ok) {
    const streamErrText = await streamResp.text();
    throw new Error(
      "AI 非流式返回空文本，流式重试失败。\n" +
      "请求体：\n" + JSON.stringify(requestBody, null, 2) +
      "\n\n非流式原文：\n" + normalRawText.slice(0, 4000) +
      "\n\n流式错误：\n" + streamErrText.slice(0, 4000)
    );
  }

  const streamText = await readStreamText(streamResp);
  if (!streamText) {
    throw new Error(
      "AI 未返回有效文本。\n" +
      "请求体：\n" + JSON.stringify(requestBody, null, 2) +
      "\n\n非流式原文：\n" + normalRawText.slice(0, 4000)
    );
  }

  return {
    raw: {
      fallback: "stream",
      normal: data
    },
    text: streamText,
    mode: "stream"
  };
}

function buildSourceData(sourceNames, limitPerSource, groups) {
  const merged = mergeNews(groups.flatMap((g) => g.items));
  const rawText = buildRawTextFromSources(
    groups.map((g) => ({
      source: g.source,
      items: g.items
    }))
  );

  return {
    ok: true,
    groups,
    requested_sources: sourceNames,
    total: merged.length,
    items: merged,
    raw_text: rawText,
    limit_per_source: limitPerSource
  };
}

async function collectSources(sourceNames, limitPerSource) {
  const groups = await Promise.all(
    sourceNames.map(async (name) => {
      const fn = SOURCES[name];
      if (!fn) {
        return { source: name, items: [], error: "来源不存在" };
      }
      try {
        const items = normalizeSourceItems(await fn()).slice(0, limitPerSource);
        return { source: name, items };
      } catch (e) {
        return {
          source: name,
          items: [],
          error: e && e.message ? e.message : String(e)
        };
      }
    })
  );

  return buildSourceData(sourceNames, limitPerSource, groups);
}

function parseSourcesFromEnv(env) {
  const raw = String(env.AUTO_RUN_SOURCES || "").trim();
  if (!raw) {
    return SOURCE_META.map((x) => x.id);
  }

  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function hasMeaningfulAggregateContent(payload) {
  if (!payload) return false;
  if ((payload.intro || "").trim()) return true;
  if ((payload.footer || "").trim()) return true;

  return (payload.items || []).some((item) => {
    return (
      (item.title || "").trim() ||
      (item.link || "").trim() ||
      (item.summary || "").trim()
    );
  });
}

async function runScheduledAggregate(env) {
  const sourceNames = parseSourcesFromEnv(env);
  const limitPerSource = Math.min(
    Math.max(Number(env.AUTO_RUN_LIMIT_PER_SOURCE || 8), 1),
    20
  );

  if (!sourceNames.length) {
    throw new Error("AUTO_RUN_SOURCES 为空，无法执行定时任务");
  }

  const sourceData = await collectSources(sourceNames, limitPerSource);
  const rawText = String(sourceData.raw_text || "").trim();
  if (!rawText) {
    throw new Error("定时抓取完成，但 raw_text 为空");
  }

  const aiApiUrl = String(env.AUTO_RUN_AI_API_URL || env.AI_API_URL || "").trim();
  const aiApiKey = String(env.AUTO_RUN_AI_API_KEY || env.AI_API_KEY || "").trim();
  const aiModel = String(env.AUTO_RUN_AI_MODEL || env.AI_MODEL || "").trim();
  const systemPrompt = String(
    env.AUTO_RUN_AI_SYSTEM_PROMPT || env.AI_SYSTEM_PROMPT || DEFAULT_AI_SYSTEM_PROMPT
  ).trim();

  if (!aiApiUrl) throw new Error("缺少 AUTO_RUN_AI_API_URL（或 AI_API_URL）");
  if (!aiApiKey) throw new Error("缺少 AUTO_RUN_AI_API_KEY（或 AI_API_KEY）");
  if (!aiModel) throw new Error("缺少 AUTO_RUN_AI_MODEL（或 AI_MODEL）");

  const aiResult = await callAiApi({
    aiApiUrl,
    aiApiKey,
    aiModel,
    systemPrompt,
    rawText: rawText.slice(0, 12000)
  });

  const parsed = parseAiJson(aiResult.text);
  const maxItems = resolveMaxAggregateItems(env.AUTO_RUN_MAX_ITEMS, DEFAULT_MAX_AGGREGATE_ITEMS);
  const items = normalizeAggregateItems(parsed && parsed.items || [], maxItems);

  const payload = {
    title: String(env.AUTO_RUN_TITLE || parsed?.title || "信息聚合").trim(),
    intro: String(env.AUTO_RUN_INTRO || parsed?.intro || "").trim(),
    footer: String(env.AUTO_RUN_FOOTER || parsed?.footer || "").trim(),
    items
  };

  if (!hasMeaningfulAggregateContent(payload)) {
    throw new Error("AI 整理完成，但没有可发送内容");
  }

  const chatId = String(env.AUTO_RUN_CHAT_ID || env.DEFAULT_CHAT_ID || "").trim();
  if (!chatId) {
    throw new Error("缺少 AUTO_RUN_CHAT_ID（或 DEFAULT_CHAT_ID）");
  }

  const messageMode = env.AUTO_RUN_MESSAGE_MODE === "text" ? "text" : "post";
  const message = messageMode === "text" ? buildTextMessage(payload) : buildPostMessage(payload);
  const sendResult = await sendFeishuMessage(env, chatId, message.msg_type, message.content);

  return {
    source_total: sourceData.total,
    ai_mode: aiResult.mode || "json",
    chat_id: chatId,
    message_mode: message.msg_type,
    preview: message.preview,
    result: sendResult.data || sendResult
  };
}

async function handleFetchSources(request) {
  const body = await request.json().catch(() => ({}));
  const sourceNames = Array.isArray(body && body.sources) ? body.sources : [];
  const limitPerSource = Math.min(Math.max(Number(body && body.limit_per_source || 8), 1), 20);

  if (!sourceNames.length) {
    return json({ ok: false, error: "请至少选择一个来源" }, 400);
  }

  return json(await collectSources(sourceNames, limitPerSource));
}

async function handleAiOrganize(request) {
  const body = await request.json().catch(() => ({}));

  const aiApiUrl = String(body && body.ai_api_url || "").trim();
  const aiApiKey = String(body && body.ai_api_key || "").trim();
  const aiModel = String(body && body.ai_model || "").trim();
  const systemPrompt = String(body && body.system_prompt || DEFAULT_AI_SYSTEM_PROMPT).trim();
  const rawText = String(body && body.raw_text || "").trim();
  const maxItems = resolveMaxAggregateItems(body && body.max_items, DEFAULT_MAX_AGGREGATE_ITEMS);

  if (!aiApiUrl) return json({ ok: false, error: "缺少 ai_api_url" }, 400);
  if (!aiApiKey) return json({ ok: false, error: "缺少 ai_api_key" }, 400);
  if (!aiModel) return json({ ok: false, error: "缺少 ai_model" }, 400);
  if (!rawText) return json({ ok: false, error: "缺少 raw_text" }, 400);

  const aiResult = await callAiApi({
    aiApiUrl,
    aiApiKey,
    aiModel,
    systemPrompt,
    rawText: rawText.slice(0, 12000)
  });

  const parsed = parseAiJson(aiResult.text);

  const data = {
    title: String(parsed && parsed.title || "").trim(),
    intro: String(parsed && parsed.intro || "").trim(),
    footer: String(parsed && parsed.footer || "").trim(),
    items: normalizeAggregateItems(parsed && parsed.items || [], maxItems)
  };

  return json({
    ok: true,
    data,
    ai_text: aiResult.text,
    usage: aiResult.raw && aiResult.raw.usage ? aiResult.raw.usage : null,
    model: aiResult.raw && aiResult.raw.model ? aiResult.raw.model : aiModel
  });
}

async function handleSendAggregate(request, env) {
  const body = await request.json().catch(() => ({}));

  const chatId = String(body && body.chat_id || "").trim();
  const title = String(body && body.title || "").trim();
  const intro = String(body && body.intro || "").trim();
  const footer = String(body && body.footer || "").trim();
  const messageMode = body && body.message_mode === "text" ? "text" : "post";
  const items = normalizeAggregateItems(body && body.items || [], 20);

  if (!chatId) return json({ ok: false, error: "缺少 chat_id" }, 400);
  if (!title && !intro && items.length === 0 && !footer) {
    return json({ ok: false, error: "没有可发送的聚合内容" }, 400);
  }

  const payload = {
    title: title || "信息聚合",
    intro,
    footer,
    items
  };

  const message = messageMode === "text" ? buildTextMessage(payload) : buildPostMessage(payload);
  const sendResult = await sendFeishuMessage(env, chatId, message.msg_type, message.content);

  return json({
    ok: true,
    chat_id: chatId,
    message_mode: message.msg_type,
    preview: message.preview,
    result: sendResult.data || sendResult
  });
}

function renderAppHtml(defaultChatId = "") {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>飞书聚合发送台</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
      background: #f5f7fb;
      color: #1f2329;
    }
    .wrap {
      max-width: 1180px;
      margin: 24px auto;
      padding: 0 16px;
    }
    .card {
      background: #fff;
      border-radius: 16px;
      box-shadow: 0 6px 24px rgba(31,35,41,.08);
      padding: 20px;
      margin-bottom: 16px;
    }
    h1 {
      margin: 0 0 8px;
      font-size: 28px;
    }
    .desc {
      color: #646a73;
      margin-bottom: 20px;
    }
    .grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
    }
    .full { grid-column: 1 / -1; }
    label {
      display: block;
      font-size: 14px;
      margin-bottom: 6px;
      color: #4e5969;
    }
    input, textarea, select, button { width: 100%; font: inherit; }
    input, textarea, select {
      border: 1px solid #d0d7de;
      border-radius: 10px;
      padding: 10px 12px;
      background: #fff;
      outline: none;
    }
    textarea { min-height: 100px; resize: vertical; }
    #aiRawText { min-height: 200px; }
    #aiSystemPrompt { min-height: 160px; }
    input:focus, textarea:focus, select:focus {
      border-color: #3370ff;
      box-shadow: 0 0 0 3px rgba(51,112,255,.12);
    }
    .row { display: flex; gap: 10px; align-items: center; }
    .row > * { flex: 1; }
    .btn {
      border: none;
      border-radius: 10px;
      padding: 10px 14px;
      cursor: pointer;
      transition: .2s;
    }
    .btn:disabled { opacity: .65; cursor: not-allowed; }
    .btn-primary { background: #3370ff; color: #fff; }
    .btn-primary:hover { background: #245bdb; }
    .btn-secondary { background: #eef3ff; color: #245bdb; }
    .btn-danger { background: #fff1f0; color: #cf1322; width: auto; }
    .items {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .item {
      border: 1px solid #e5e6eb;
      border-radius: 12px;
      padding: 12px;
      background: #fafbfc;
    }
    .item-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 10px;
      font-weight: 600;
      gap: 10px;
    }
    pre {
      white-space: pre-wrap;
      word-break: break-word;
      background: #0b1220;
      color: #e5edf7;
      border-radius: 12px;
      padding: 14px;
      min-height: 120px;
      overflow: auto;
    }
    .muted { color: #86909c; font-size: 13px; }
    .topbar {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
      align-items: center;
    }
    .status { font-size: 14px; color: #4e5969; }
    .source-box {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
      gap: 10px;
    }
    .source-item {
      display: flex;
      align-items: center;
      gap: 8px;
      border: 1px solid #e5e6eb;
      border-radius: 10px;
      padding: 10px 12px;
      background: #fff;
    }
    .source-item input { width: auto; }
    @media (max-width: 860px) {
      .grid { grid-template-columns: 1fr; }
      .row { flex-direction: column; align-items: stretch; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <div class="topbar">
        <div>
          <h1>飞书聚合发送台</h1>
          <div class="desc">来源抓取 → AI 整理 → 一键发送到飞书群。整套都跑在 Cloudflare Worker 上。</div>
        </div>
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
          <button class="btn btn-secondary" id="runScheduledOnceBtn" type="button">手动触发一次定时任务</button>
          <div class="status" id="statusText">准备就绪</div>
        </div>
      </div>

      <div class="grid">
        <div>
          <label>访问口令（WORKER_TOKEN）</label>
          <input id="token" type="password" placeholder="如果你配置了 WORKER_TOKEN，就在这里填写" />
        </div>

        <div>
          <label>发送群</label>
          <div class="row">
            <select id="chatSelect"></select>
            <button class="btn btn-secondary" id="loadChatsBtn" type="button">刷新群列表</button>
          </div>
        </div>

        <div>
          <label>消息类型</label>
          <select id="messageMode">
            <option value="post" selected>富文本 post</option>
            <option value="text">纯文本 text</option>
          </select>
        </div>

        <div>
          <label>聚合标题</label>
          <input id="title" type="text" placeholder="例如：今日资讯汇总" />
        </div>

        <div class="full">
          <label>导语</label>
          <textarea id="intro" placeholder="例如：以下为今天整理的重点信息，请查收。"></textarea>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="topbar">
        <strong>聚合来源</strong>
        <button class="btn btn-secondary" id="fetchSourcesBtn" type="button">抓取选中来源</button>
      </div>
      <div id="sourceList" class="source-box"></div>
      <div class="muted" style="margin-top:10px;">已选来源会自动保存在浏览器，下次打开仍然保留。</div>
    </div>

    <div class="card">
      <div class="topbar">
        <strong>AI 整理</strong>
        <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;">
          <label style="display:flex;align-items:center;gap:8px;margin:0;font-size:14px;color:#4e5969;">
            <input id="autoSendAfterAi" type="checkbox" style="width:auto;" checked />
            <span>AI 整理后自动发送</span>
          </label>
          <button class="btn btn-secondary" id="aiOrganizeBtn" type="button">AI 整理原始内容</button>
        </div>
      </div>

      <div class="grid">
        <div class="full">
          <label>AI API 地址</label>
          <input id="aiApiUrl" type="text" placeholder="例如：https://api.openai.com/v1/chat/completions" />
        </div>

        <div>
          <label>AI 模型</label>
          <input id="aiModel" type="text" placeholder="例如：gpt-4o-mini / deepseek-chat" />
        </div>

        <div>
          <label>AI API Key</label>
          <input id="aiApiKey" type="password" placeholder="请输入 API Key" />
        </div>

        <div class="full">
          <label>系统提示词</label>
          <textarea id="aiSystemPrompt" placeholder="可自定义 AI 整理规则"></textarea>
        </div>

        <div class="full">
          <label>原始内容</label>
          <textarea id="aiRawText" placeholder="可以手动粘贴，也可以通过上面的来源抓取自动填充"></textarea>
        </div>
      </div>

      <div class="muted" style="margin-top:10px;">AI 地址、Key、Prompt 只保存在当前浏览器 localStorage，不保存在 Worker 环境变量。</div>
    </div>

    <div class="card">
      <div class="topbar">
        <strong>聚合条目</strong>
        <button class="btn btn-secondary" id="addItemBtn" type="button">+ 添加一条</button>
      </div>
      <div class="items" id="items"></div>
      <div class="muted" style="margin-top:10px;">AI 整理完成后会自动填充到这里，你也可以手动修改。</div>
    </div>

    <div class="card">
      <div class="grid">
        <div class="full">
          <label>结尾说明</label>
          <textarea id="footer" placeholder="例如：以上内容由 Cloudflare Worker 聚合发送。"></textarea>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="topbar">
        <strong>消息预览</strong>
        <button class="btn btn-primary" id="sendBtn" type="button">发送到飞书群</button>
      </div>
      <pre id="preview"></pre>
    </div>

    <div class="card">
      <strong>返回结果</strong>
      <pre id="result">尚未执行</pre>
    </div>
  </div>

  <script>
    window.DEFAULT_CHAT_ID = ${JSON.stringify(defaultChatId || "")};
    window.DEFAULT_AI_SYSTEM_PROMPT = ${JSON.stringify(DEFAULT_AI_SYSTEM_PROMPT)};
    window.SOURCE_META = ${JSON.stringify(SOURCE_META)};
  </script>

  <script>
    (function () {
      var $ = function (id) { return document.getElementById(id); };

      function setStatus(text) {
        $("statusText").textContent = text;
      }

      function getToken() {
        return ($("token").value || "").trim();
      }

      function getSelectedSources() {
        return Array.from(document.querySelectorAll(".source-checkbox:checked")).map(function (el) {
          return el.value;
        });
      }

      function saveDraft() {
        var draft = {
          token: getToken(),
          chat_id: $("chatSelect").value || "",
          message_mode: $("messageMode").value || "post",
          title: $("title").value || "",
          intro: $("intro").value || "",
          footer: $("footer").value || "",
          items: collectItems(),
          selected_sources: getSelectedSources(),
          auto_send_after_ai: !!$("autoSendAfterAi").checked,

          ai_api_url: $("aiApiUrl").value || "",
          ai_api_key: $("aiApiKey").value || "",
          ai_model: $("aiModel").value || "",
          ai_system_prompt: $("aiSystemPrompt").value || "",
          ai_raw_text: $("aiRawText").value || ""
        };

        localStorage.setItem("digest_draft_all_in_one_v1", JSON.stringify(draft));
        localStorage.setItem("worker_token_v1", draft.token || "");
      }

      function loadDraft() {
        try {
          var raw = localStorage.getItem("digest_draft_all_in_one_v1");
          if (!raw) return null;
          var draft = JSON.parse(raw);

          if (draft.token) $("token").value = draft.token;
          if (draft.message_mode) $("messageMode").value = draft.message_mode;
          if (draft.title) $("title").value = draft.title;
          if (draft.intro) $("intro").value = draft.intro;
          if (draft.footer) $("footer").value = draft.footer;
          if (draft.ai_api_url) $("aiApiUrl").value = draft.ai_api_url;
          if (draft.ai_api_key) $("aiApiKey").value = draft.ai_api_key;
          if (draft.ai_model) $("aiModel").value = draft.ai_model;
          if (draft.ai_system_prompt) $("aiSystemPrompt").value = draft.ai_system_prompt;
          if (draft.ai_raw_text) $("aiRawText").value = draft.ai_raw_text;
          if (typeof draft.auto_send_after_ai === "boolean") {
            $("autoSendAfterAi").checked = draft.auto_send_after_ai;
          } else {
            $("autoSendAfterAi").checked = true;
          }

          $("items").innerHTML = "";
          if (Array.isArray(draft.items) && draft.items.length) {
            draft.items.forEach(function (item) { addItem(item); });
          }

          return draft;
        } catch (e) {
          console.error(e);
          return null;
        }
      }

      function escapeHtmlAttr(str) {
        return String(str)
          .replace(/&/g, "&amp;")
          .replace(/"/g, "&quot;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;");
      }

      function escapeHtmlText(str) {
        return String(str)
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;");
      }

      function createItemEl(item, index) {
        var el = document.createElement("div");
        el.className = "item";
        el.innerHTML = ''
          + '<div class="item-head">'
          +   '<span>条目 ' + (index + 1) + '</span>'
          +   '<button class="btn btn-danger remove-item" type="button">删除</button>'
          + '</div>'
          + '<div class="grid">'
          +   '<div class="full">'
          +     '<label>标题</label>'
          +     '<input class="item-title" type="text" placeholder="例如：某篇文章 / 某条公告" value="' + escapeHtmlAttr(item.title || "") + '" />'
          +   '</div>'
          +   '<div class="full">'
          +     '<label>链接</label>'
          +     '<input class="item-link" type="text" placeholder="https://example.com/..." value="' + escapeHtmlAttr(item.link || "") + '" />'
          +   '</div>'
          +   '<div class="full">'
          +     '<label>摘要</label>'
          +     '<textarea class="item-summary" placeholder="简短说明这条信息的重点">' + escapeHtmlText(item.summary || "") + '</textarea>'
          +   '</div>'
          + '</div>';

        el.querySelector(".remove-item").addEventListener("click", function () {
          el.remove();
          renumberItems();
          renderPreview();
          saveDraft();
        });

        var inputs = el.querySelectorAll("input, textarea");
        inputs.forEach(function (node) {
          node.addEventListener("input", function () {
            renderPreview();
            saveDraft();
          });
          node.addEventListener("change", function () {
            renderPreview();
            saveDraft();
          });
        });

        return el;
      }

      function renumberItems() {
        Array.from(document.querySelectorAll(".item")).forEach(function (el, idx) {
          var span = el.querySelector(".item-head span");
          if (span) span.textContent = "条目 " + (idx + 1);
        });
      }

      function addItem(item) {
        var container = $("items");
        var el = createItemEl(item || {}, container.children.length);
        container.appendChild(el);
      }

      function collectItems() {
        return Array.from(document.querySelectorAll(".item")).map(function (el) {
          return {
            title: (el.querySelector(".item-title").value || "").trim(),
            link: (el.querySelector(".item-link").value || "").trim(),
            summary: (el.querySelector(".item-summary").value || "").trim()
          };
        }).filter(function (item) {
          return item.title || item.link || item.summary;
        });
      }

      function collectPayload() {
        return {
          chat_id: ($("chatSelect").value || "").trim(),
          message_mode: $("messageMode").value || "post",
          title: ($("title").value || "").trim(),
          intro: ($("intro").value || "").trim(),
          footer: ($("footer").value || "").trim(),
          items: collectItems()
        };
      }

      function hasMeaningfulContent(payload) {
        if (!payload) return false;

        if ((payload.intro || "").trim()) return true;
        if ((payload.footer || "").trim()) return true;

        return (payload.items || []).some(function (item) {
          return (item.title || "").trim() || (item.link || "").trim() || (item.summary || "").trim();
        });
      }

      function getAiPayload() {
        return {
          ai_api_url: ($("aiApiUrl").value || "").trim(),
          ai_api_key: ($("aiApiKey").value || "").trim(),
          ai_model: ($("aiModel").value || "").trim(),
          system_prompt: ($("aiSystemPrompt").value || "").trim(),
          raw_text: ($("aiRawText").value || "").trim()
        };
      }

      function buildPreview(payload) {
        var lines = [];
        var title = payload.title || "信息聚合";
        lines.push("【" + title + "】");

        if (payload.intro) lines.push(payload.intro);

        (payload.items || []).forEach(function (item, index) {
          lines.push("");
          lines.push((index + 1) + ". " + (item.title || "未命名条目"));
          if (item.summary) lines.push("摘要：" + item.summary);
          if (item.link) lines.push("链接：" + item.link);
        });

        if (payload.footer) {
          lines.push("");
          lines.push(payload.footer);
        }

        return lines.join("\\n").trim();
      }

      function renderPreview() {
        var payload = collectPayload();
        $("preview").textContent = buildPreview(payload) || "暂无内容";
      }

      async function api(path, options) {
        var token = getToken();
        var opts = options || {};
        var headers = Object.assign({}, opts.headers || {});
        if (token) headers["x-worker-token"] = token;
        opts.headers = headers;

        var resp = await fetch(path, opts);
        var text = await resp.text();
        var data;

        try {
          data = JSON.parse(text);
        } catch (e) {
          if (!resp.ok) throw new Error(text || "请求失败");
          return text;
        }

        if (!resp.ok || (data && data.ok === false)) {
          throw new Error((data && data.error) || text || "请求失败");
        }

        return data;
      }

      async function loadChats() {
        try {
          setStatus("正在加载群列表...");
          var data = await api("/api/chats");
          var select = $("chatSelect");
          var items = data.items || [];
          select.innerHTML = "";

          if (!items.length) {
            var emptyOpt = document.createElement("option");
            emptyOpt.value = "";
            emptyOpt.textContent = "没有可用群";
            select.appendChild(emptyOpt);
            setStatus("未找到群");
            return;
          }

          items.forEach(function (item) {
            var opt = document.createElement("option");
            opt.value = item.chat_id;
            opt.textContent = item.name + "（" + item.chat_id + "）";
            select.appendChild(opt);
          });

          var savedChatId = "";
          try {
            var raw = localStorage.getItem("digest_draft_all_in_one_v1");
            if (raw) savedChatId = JSON.parse(raw).chat_id || "";
          } catch (e) {}

          select.value = savedChatId || window.DEFAULT_CHAT_ID || items[0].chat_id;
          saveDraft();
          renderPreview();
          setStatus("群列表加载完成，共 " + items.length + " 个");
        } catch (err) {
          setStatus("加载群列表失败");
          $("result").textContent = String(err.message || err);
        }
      }

      function loadSources(selected) {
        var box = $("sourceList");
        box.innerHTML = "";

        (window.SOURCE_META || []).forEach(function (item) {
          var label = document.createElement("label");
          label.className = "source-item";
          var checked = Array.isArray(selected) && selected.indexOf(item.id) !== -1 ? "checked" : "";
          label.innerHTML =
            '<input type="checkbox" class="source-checkbox" value="' + item.id + '" ' + checked + ' />' +
            '<span>' + item.name + '（' + item.id + '）</span>';
          box.appendChild(label);
        });

        Array.from(document.querySelectorAll(".source-checkbox")).forEach(function (node) {
          node.addEventListener("change", saveDraft);
        });
      }

      async function fetchSelectedSources() {
        try {
          var names = getSelectedSources();
          if (!names.length) {
            alert("请先勾选来源");
            return;
          }

          setStatus("正在抓取来源...");
          $("fetchSourcesBtn").disabled = true;

          var data = await api("/api/fetch-sources", {
            method: "POST",
            headers: {
              "content-type": "application/json; charset=utf-8"
            },
            body: JSON.stringify({
              sources: names,
              limit_per_source: 8
            })
          });

          $("aiRawText").value = data.raw_text || "";
          $("result").textContent = JSON.stringify(data, null, 2);
          saveDraft();
          setStatus("来源抓取完成，已填入原始内容");
        } catch (err) {
          $("result").textContent = String(err.message || err);
          setStatus("来源抓取失败");
        } finally {
          $("fetchSourcesBtn").disabled = false;
        }
      }

      function applyAiResult(data) {
        var oldTitle = ($("title").value || "").trim();

        $("title").value = (data.title || oldTitle || "今日资讯").trim();
        $("intro").value = (data.intro || "").trim();
        $("footer").value = (data.footer || "").trim();
        $("items").innerHTML = "";

        var items = Array.isArray(data.items) ? data.items : [];
        items.forEach(function (item) {
          addItem({
            title: item.title || "",
            link: item.link || "",
            summary: item.summary || ""
          });
        });

        renumberItems();
        renderPreview();
        saveDraft();
      }

      async function aiOrganize() {
        try {
          var payload = getAiPayload();

          if (!payload.ai_api_url) { alert("请填写 AI API 地址"); return; }
          if (!payload.ai_api_key) { alert("请填写 AI API Key"); return; }
          if (!payload.ai_model) { alert("请填写 AI 模型"); return; }
          if (!payload.raw_text) { alert("请先输入原始内容"); return; }

          setStatus("AI 正在整理...");
          $("aiOrganizeBtn").disabled = true;

          var data = await api("/api/ai-organize", {
            method: "POST",
            headers: {
              "content-type": "application/json; charset=utf-8"
            },
            body: JSON.stringify(payload)
          });

          $("result").textContent = JSON.stringify(data, null, 2);

          if (!data || !data.data) {
            throw new Error("AI 未返回可用整理结果");
          }

          applyAiResult(data.data);

          var finalPayload = collectPayload();
          if (!hasMeaningfulContent(finalPayload)) {
            throw new Error("AI 整理完成，但没有生成正文内容，已停止自动发送");
          }

          if ($("autoSendAfterAi").checked) {
            setStatus("AI 整理完成，正在自动发送...");
            await sendAggregate({ silent: true });
          } else {
            setStatus("AI 整理完成");
          }
        } catch (err) {
          $("result").textContent = String(err.message || err);
          setStatus("AI 整理失败");
        } finally {
          $("aiOrganizeBtn").disabled = false;
        }
      }

      async function sendAggregate(options) {
        options = options || {};
        var silent = !!options.silent;

        try {
          var payload = collectPayload();

          if (!payload.chat_id) {
            if (!silent) alert("请选择发送群");
            throw new Error("请选择发送群");
          }

          if (!payload.title && !payload.intro && payload.items.length === 0 && !payload.footer) {
            if (!silent) alert("请至少填写标题、导语、结尾或一条聚合信息");
            throw new Error("没有可发送内容");
          }

          setStatus("正在发送...");
          $("sendBtn").disabled = true;

          var data = await api("/api/send-aggregate", {
            method: "POST",
            headers: {
              "content-type": "application/json; charset=utf-8"
            },
            body: JSON.stringify(payload)
          });

          $("result").textContent = JSON.stringify(data, null, 2);
          setStatus("发送成功");
          saveDraft();
          return data;
        } catch (err) {
          $("result").textContent = String(err.message || err);
          setStatus("发送失败");
          throw err;
        } finally {
          $("sendBtn").disabled = false;
        }
      }

      async function runScheduledOnce() {
        try {
          setStatus("正在手动触发定时任务...");
          $("runScheduledOnceBtn").disabled = true;

          var data = await api("/api/run-scheduled", {
            method: "POST",
            headers: {
              "content-type": "application/json; charset=utf-8"
            }
          });

          $("result").textContent = JSON.stringify(data, null, 2);
          setStatus("手动触发成功");
          return data;
        } catch (err) {
          $("result").textContent = String(err.message || err);
          setStatus("手动触发失败");
          throw err;
        } finally {
          $("runScheduledOnceBtn").disabled = false;
        }
      }

      $("addItemBtn").addEventListener("click", function () {
        addItem({});
        renumberItems();
        renderPreview();
        saveDraft();
      });

      $("sendBtn").addEventListener("click", sendAggregate);
      $("aiOrganizeBtn").addEventListener("click", aiOrganize);
      $("loadChatsBtn").addEventListener("click", loadChats);
      $("fetchSourcesBtn").addEventListener("click", fetchSelectedSources);
      $("runScheduledOnceBtn").addEventListener("click", runScheduledOnce);

      $("chatSelect").addEventListener("change", function () {
        renderPreview();
        saveDraft();
      });

      [
        "token",
        "title",
        "intro",
        "footer",
        "messageMode",
        "aiApiUrl",
        "aiApiKey",
        "aiModel",
        "aiSystemPrompt",
        "aiRawText",
        "autoSendAfterAi"
      ].forEach(function (id) {
        $(id).addEventListener("input", function () {
          renderPreview();
          saveDraft();
        });
        $(id).addEventListener("change", function () {
          renderPreview();
          saveDraft();
        });
      });

      (function init() {
        try {
          var tokenFromUrl = new URL(location.href).searchParams.get("token");
          var savedToken = localStorage.getItem("worker_token_v1") || "";

          if (tokenFromUrl) $("token").value = tokenFromUrl;
          else if (savedToken) $("token").value = savedToken;

          var draft = loadDraft();

          if (!$("aiSystemPrompt").value) {
            $("aiSystemPrompt").value = window.DEFAULT_AI_SYSTEM_PROMPT || "";
          }

          loadSources((draft && draft.selected_sources) || []);

          if (document.querySelectorAll(".item").length === 0) addItem({});

          renderPreview();
          setStatus("如配置了 WORKER_TOKEN，请先输入；然后点击刷新群列表");

          if ($("token").value) {
            loadChats();
          }
        } catch (e) {
          console.error(e);
          setStatus("初始化失败");
        }
      })();
    })();
  </script>
</body>
</html>`;
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const pathname = url.pathname;

      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204 });
      }

      if (pathname === "/") {
        return html(renderAppHtml(env.DEFAULT_CHAT_ID || ""));
      }

      if (pathname === "/api/chats") {
        const authResp = requireAuth(request, url, env);
        if (authResp) return authResp;
        return json(await listChats(env));
      }

      if (pathname === "/api/fetch-sources") {
        const authResp = requireAuth(request, url, env);
        if (authResp) return authResp;
        if (request.method !== "POST") {
          return json({ ok: false, error: "Method Not Allowed" }, 405);
        }
        return await handleFetchSources(request);
      }

      if (pathname === "/api/ai-organize") {
        const authResp = requireAuth(request, url, env);
        if (authResp) return authResp;
        if (request.method !== "POST") {
          return json({ ok: false, error: "Method Not Allowed" }, 405);
        }
        return await handleAiOrganize(request);
      }

      if (pathname === "/api/send-aggregate") {
        const authResp = requireAuth(request, url, env);
        if (authResp) return authResp;
        if (request.method !== "POST") {
          return json({ ok: false, error: "Method Not Allowed" }, 405);
        }
        return await handleSendAggregate(request, env);
      }

      if (pathname === "/api/run-scheduled") {
        const authResp = requireAuth(request, url, env);
        if (authResp) return authResp;
        if (request.method !== "POST") {
          return json({ ok: false, error: "Method Not Allowed" }, 405);
        }

        const result = await runScheduledAggregate(env);
        return json({ ok: true, trigger: "manual", result });
      }

      return json({ ok: false, error: "Not Found" }, 404);
    } catch (err) {
      return json(
        {
          ok: false,
          error: err && err.message ? err.message : String(err)
        },
        500
      );
    }
  },

  async scheduled(controller, env, ctx) {
    const enabled = String(env.AUTO_RUN_ENABLED || "true").toLowerCase();
    if (["0", "false", "off", "no"].includes(enabled)) {
      console.log("[scheduled] AUTO_RUN_ENABLED=false, skip");
      return;
    }

    const run = async () => {
      try {
        const result = await runScheduledAggregate(env);
        console.log("[scheduled] success", JSON.stringify(result));
      } catch (err) {
        console.error(
          "[scheduled] failed",
          err && err.message ? err.message : String(err)
        );
      }
    };

    if (ctx && typeof ctx.waitUntil === "function") {
      ctx.waitUntil(run());
      return;
    }

    await run();
  }
};

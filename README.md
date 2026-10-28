# 福建足迹 · Fujian Footprints

一张可以点亮的福建县区地图。记录自己去过的地方，查看全省及各市进度；用随机保存码在不同设备间继续记录，无需注册或登录。

**在线体验：[jimmie.cn/fujian](https://jimmie.cn/fujian/)**

## 功能

- 福建9市、84个县级行政区：42县、31市辖区、11县级市。
- 地图和县区清单同步标记，支持搜索、筛选、城市批量操作、缩放与撤销。
- 初始为空，不预填任何人的旅行经历。
- 本地自动保存、JSON备份与恢复。
- 生成随机保存码，复制专属链接、下载保存码；换设备恢复同一份记录。
- 云端确认后才显示已同步；断网或响应丢失时保留本地待同步操作。
- 不同设备修改不同县区时合并；撤销只作用于本机上一操作涉及的县区。

## 本地运行

需要 Node.js 20 或更高版本；建议使用 Node.js 22。

```bash
npm ci
npm run dev
```

打开 `http://127.0.0.1:4875/`，也可以使用 `/fujian/` 入口。通过 `PORT` 环境变量修改端口。

本地开发使用文件存储适配器，数据保存在 `.dev-data/records.json`，重启后仍保留；这些文件已被 Git 忽略。无需云平台密钥即可运行前后端。

```bash
npm test
npm run build
npm run check
```

构建输出 `.site-output/` 只包含页面、样式、脚本和公开地图数据；后端源码、配置、测试、开发记录均不会作为静态文件发布。

## 独立部署到 EdgeOne Makers

1. Fork 或克隆本仓库，在 EdgeOne Makers 中导入仓库。
2. 使用项目根目录；`edgeone.json` 已配置 `npm ci`、`npm run build` 和输出目录 `.site-output`。
3. 保留 `cloud-functions/`，平台会构建 `/api/fujian-record` Node 云函数。
4. 云函数通过官方 `@edgeone/pages-blob` SDK使用项目内的 `fujian-footprints-v1` 存储空间，不需要把云平台凭据写进前端或仓库。
5. 部署后检查 `/fujian/build-meta.json` 的提交版本，再创建一份测试记录并换浏览器恢复。

仅部署静态文件时，本机标记及备份仍可使用；保存码同步需要同时部署后端。不同 EdgeOne 项目的存储相互独立，Fork 不会获得线上实例或其他人的足迹记录。

可显式指定**自己的测试环境**运行完整接口验收；脚本会创建新测试码并清理对应测试记录：

```bash
npm run test:live -- https://your-deployment.example
```

该命令不设置默认线上目标，自动测试也不会访问体验站或使用真实个人记录。

## 保存码如何工作

浏览器用 Web Crypto 生成24字节随机数，形成 `FJ1-` 开头的36字符保存码。服务器只用带命名空间的 SHA-256 哈希定位记录；请求通过 `Authorization` 头携带保存码，不提供公共记录列表。

专属链接使用 URL 片段 `#code=…`，片段不会随网页请求发送给服务器。页面读取后清除地址中的片段。每个修改有独立操作ID，本地队列在服务器确认前保留原ID；服务端以不可变回执处理重试和并发，而不是覆盖整份快照。

**保存码就是读写钥匙。** 拿到码的人可以查看和修改这份足迹；没有姓名、手机号等身份绑定，丢失后无法通过身份找回。不要把真实保存码、专属链接或个人记录贴进公开 Issue。更多实现边界见 [SECURITY.md](SECURITY.md)。

## 目录

```text
fujian/                   地图页面、样式、保存码客户端
cloud-functions/api/      同源存储接口
cloud-functions/_lib/     记录合并逻辑、县区代码白名单
tests/                    单元与集成测试、显式目标线上验收
scripts/                  本地开发、白名单构建、静态检查
.github/workflows/        自动测试与构建
```

## 名单、地图和第三方归属

- 县区名单：[福建省民政厅名录（截至2026年6月30日）](https://mzt.fj.gov.cn/gk/tzgg/202607/t20260710_7176497.htm)。84个县区包含泉州组的金门县；平潭县按行政区划列于福州组，由平潭综合实验区管理。
- 边界几何：[阿里云 DataV.GeoAtlas](https://datav.aliyun.com/portal/school/atlas/area_selector)。边界已转换为页面内嵌SVG路径，并对应现行县区名称和代码。
- 存储SDK：[Tencent EdgeOne Pages Blob](https://www.npmjs.com/package/@edgeone/pages-blob)，依赖版本在锁文件中固定。

地图用于个人足迹示意，不用于界线认定。第三方数据的权利归其原权利人；本仓库未将其声明为作者自有数据。

## 仓库与线上实例

这是独立公开项目仓库，使用全新的 Git 历史，不包含个人网站的其他内容、部署凭据或访客记录。现有在线体验仍由既有网站项目提供服务；本仓库可独立部署，记录不会自动迁移或共享。

本仓库当前未附开源许可证。

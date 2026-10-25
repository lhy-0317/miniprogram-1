# 智惠本草

基于微信云开发的自助购纸与中医药科普小程序。用户可选购纸巾、参加限时答题、领取优惠券并查看订单；运营人员通过独立 Web 后台管理商品、题库、用户、订单和反馈。

当前导航为 **商店 / 答题 / AR识别 / 我的**，开屏后进入商店。支付和设备履约包含体验流程，AR 为演示页面，具体状态见文末。

## 功能

| 模块 | 当前能力 |
| --- | --- |
| 商店 | 商品列表、库存展示、数量选择、优惠券抵扣、服务端询价与下单 |
| 趣味答题 | 单选、多选、判断题，限时答题、服务端判卷、解析、成绩与历史记录 |
| 优惠券 | 答题随机奖励、后台发放、未使用/已使用/已过期筛选、下单核销与取消退券 |
| 订单 | 列表、详情、分页、状态筛选、支付、取消与确认取货 |
| 个人中心 | 微信头像昵称填写、资料编辑、答题与购纸统计、记录入口 |
| 帮助与反馈 | 常见问题、文字和图片反馈、后台处理状态与回复 |
| 管理后台 | 数据概览、用户、商品、优惠券、题库、答题记录、订单、反馈及诊断接口 |
| AR识别 | 静态场景、固定药材资料与识别交互演示 |

### 答题与奖励规则

- 每轮限时 **3 分钟**，一次下发一道题，累计答对 **5 道**即结束并尝试发放奖励；答错不清零。
- 每位用户每天最多获得 **3 张答题奖励券**，有效期 **30 天**。
- 券池：免费领纸券 **5%**、买2送1券 **15%**、8折购物券 **80%**。
- 题目答案在服务端判定；下发题目不含正确答案，提交时校验本轮已下发题号。
- 切换页面后可恢复本轮进度，计时继续。

### 商店优惠规则

- 免费领纸券：免除订单中单价最低的一件商品。
- 买2送1券：同一商品每满 3 件减免 1 件。
- 8折购物券：整单优惠 20%。
- 金额统一以“分”存储和计算，页面转换为“元”；价格、库存和优惠以服务端结果为准。

## 技术架构

- **小程序**：微信原生小程序、TypeScript、WXML/WXSS、TDesign；全局样式变量位于 `miniprogram/app.wxss`。
- **后端**：7 个 Node.js 云函数、CloudBase 云数据库与云存储。
- **通信**：`miniprogram/utils/api.ts` 将 `/api/...` 路径转换为云函数名与 `action`，通过 `wx.cloud.callFunction` 调用。
- **用户身份**：云函数通过 `getWXContext().OPENID` 获取调用者身份，以 `_openid` 关联个人数据。
- **管理端身份**：管理员口令换取随机令牌，令牌有效期 2 小时，后续 HTTP 请求携带 Bearer token。
- **共享代码**：`cloudfunctions/common/index.js` 为源文件，由同步脚本复制到各业务云函数的 `common.js`，保证函数可独立部署。

```text
miniprogram-1/
├── miniprogram/                 微信小程序
│   ├── pages/                  商店、答题、个人中心、订单等页面
│   ├── config/env.ts           云环境、云函数名称及轮询配置
│   ├── utils/api.ts            云函数通信与响应封装
│   └── assets/                 图标和演示图片
├── cloudfunctions/
│   ├── common/                 共享逻辑源文件
│   ├── userService/            用户资料、统计、AR记录查询
│   ├── quizService/            抽题、判卷、答题会话、奖励、历史
│   ├── couponService/          优惠券列表与核销
│   ├── orderService/           商品目录、报价、订单、库存与支付入口
│   ├── deviceService/          设备状态与带密钥的心跳上报
│   ├── feedbackService/        用户反馈提交
│   └── adminService/           管理后台 HTTP 接口
├── admin/                      独立静态管理后台
├── prototype/                  早期 HTML 原型，供设计参考
├── scripts/                    公共库同步、云函数加载及业务回归检查
├── typings/                    小程序类型声明
├── project.config.json         微信开发者工具共享项目配置
└── package.json                小程序依赖与开发检查命令
```

`miniprogram/pages/home` 保留早期扫码取纸代码，未注册到当前页面列表。旧 Express/MQTT 后端 `back/`、本地笔记 `docs/` 和云开发工作目录仅在本地保留，已由 `.gitignore` 排除。

## 本地开发

环境：Node.js 22+、npm、微信开发者工具，以及可用的微信小程序 AppID 和 CloudBase 环境。

```bash
git clone https://github.com/lhy-0317/miniprogram-1.git
cd miniprogram-1
npm ci
npm run check
```

1. 在微信开发者工具中导入仓库根目录，确认 `miniprogramRoot` 为 `miniprogram/`，`cloudfunctionRoot` 为 `cloudfunctions/`。
2. 使用自己的 AppID 时，修改 `project.config.json` 中的 `appid`。
3. 修改 `miniprogram/config/env.ts` 中的 `CLOUD_ENV_ID`；管理后台部署地址需同时核对该文件与 `admin/js/admin-api.js` 中的 `API_BASE`。
4. 在开发者工具执行 **工具 → 构建 npm**，生成 `miniprogram/miniprogram_npm/` 后编译、预览。

本项目的小程序请求使用云函数，无需启动本地 Express 服务。

## 云开发部署

### 1. 创建数据库集合

| 集合 | 用途 |
| --- | --- |
| `users` | 用户资料、统计与当前答题会话 |
| `products` | 商品、价格、库存、排序和上下架状态 |
| `orders` | 商店及设备取纸订单、金额与状态 |
| `coupons` | 券类型、归属、来源、有效期和核销状态 |
| `quiz_question` | 题干、选项、正确答案、解析、题型、难度和分类 |
| `quiz_records` | 作答、题目快照与结果 |
| `devices` | 设备状态、余纸量和心跳 |
| `usage_records` | 设备取纸使用记录 |
| `ar_records` | AR识别记录，供未来真实识别服务写入 |
| `feedback` | 用户反馈、图片、联系方式及处理记录 |
| `admin_token` | 管理员令牌与过期时间 |
| `adm_loginf` | 管理员登录失败计数 |

业务读写统一经过云函数，客户端直连数据库权限可设为仅管理端读写，避免直接修改券、库存、订单或获取题库答案。按实际查询建立所需索引，云存储配置头像和反馈图片的上传、读取权限。

### 2. 配置云函数环境变量

| 云函数 | 环境变量 | 用途 |
| --- | --- | --- |
| `adminService` | `ADMIN_PASSWORD` | 管理员口令；账号为 `admin`，未配置时拒绝登录 |
| `deviceService` | `DEVICE_SECRET` | 设备上报共享密钥；未配置时拒绝上报 |
| `orderService` | `WECHAT_APPID` | 微信支付应用 AppID；使用自己的应用时需与项目配置一致 |
| `orderService` | `WECHAT_PAY_MCHID`、`WECHAT_PAY_API_V3_KEY` | 商户号及 API v3 密钥 |
| `orderService` | `WECHAT_PAY_SERIAL_NO`、`WECHAT_PAY_PRIVATE_KEY` | 商户证书序列号及私钥 |
| `orderService` | `WECHAT_PAY_PLATFORM_CERT`、`WECHAT_PAY_NOTIFY_URL` | 平台证书及支付通知地址 |

口令、设备密钥、支付密钥与私钥在云控制台配置。真实支付分支仍需修复和联调，补齐变量后也需完成下文所列验证。

### 3. 上传云函数

```bash
npm run sync:common
```

在微信开发者工具中，分别上传并部署 7 个业务云函数，选择云端安装依赖。`common/` 是同步源目录，无需单独部署；修改公共库后需同步并重新部署受影响的函数。

### 4. 配置管理后台 HTTP 访问服务

将路由前缀 `/admin` 指向 `adminService`，再把完整访问地址配置到 `admin/js/admin-api.js` 的 `API_BASE`。例如地址以 `/admin` 结尾时，登录请求为 `/admin/api/auth/admin/login`。

批量导入题库前，将 `adminService` 的云函数超时时间调整为 20 秒。

管理后台可作为静态站点部署。本地预览可使用 Python：

```bash
python -m http.server 8080 --directory admin
```

打开 `http://localhost:8080/login.html`，以 `admin` 和云端配置的口令登录。

### 5. 初始化商品与题库

- 在商品管理页导入默认商品，或自行新增商品并上架。
- 在题库管理页新增题目，或导入以下结构的 JSON 数组。`correct` 使用从 0 开始的选项下标；多选题用数组，`type` 支持 `single`、`multi`、`judge`。

```json
[
  {
    "question": "《本草纲目》的作者是？",
    "options": ["张仲景", "李时珍", "华佗", "孙思邈"],
    "correct": [1],
    "type": "single",
    "difficulty": "easy",
    "category": "中医药文化",
    "explanation": "《本草纲目》由明代医学家李时珍编著。"
  }
]
```

题库为空时，云函数使用 5 道兜底题；在售商品查询为空时，当前代码会回退内置商品目录。

## 开发检查

| 命令 | 内容 |
| --- | --- |
| `npm run sync:common` | 同步各业务云函数的公共库 |
| `npm run verify:fn` | 使用内存 SDK mock 检查 7 个云函数模块加载 |
| `npm run test:questions` | 题库、答题、奖励、商品、订单、反馈及页面约定回归检查 |
| `npm run lint` | 小程序 TypeScript 的 ESLint 检查 |
| `npm run typecheck` | 小程序及类型声明的 TypeScript 检查 |
| `npm run check` | 顺序执行上述全部检查 |

云函数本地测试使用内存 mock，不会访问真实云数据库。线上部署、数据库权限、真实支付和硬件行为需在各自环境验证。

## 当前限制与待完善项

- **支付与自提**：商店提示到服务台付款取货；未配置支付参数时，订单页采用模拟支付，不发生真实扣款。真实支付的签名、验签及解密调用仍需修复和完整联调。
- **设备取纸**：当前扣库存后直接标记订单完成，尚未接入设备指令、MQTT 网关与执行确认；旧免费取纸分支仍存在变量引用错误。
- **订单一致性**：并发取消订单可能重复回补库存；下单扣库存、核销券和写订单之间仍需补齐异常补偿。
- **商品下架**：全部商品下架后会触发默认目录回退，需要区分商品库未初始化与全部下架。
- **AR**：当前为固定人参资料及静态图片演示，尚未接入真实识别、3D 手势交互及识别记录写入。
- **提醒**：设置中的通知和券到期提醒开关目前保存本地偏好，尚未接入订阅消息发送。

## 仓库文件约定

提交源码、必要静态资源、类型声明、依赖清单及 `package-lock.json`，并提交各云函数部署所需的 `common.js` 副本。

`.gitignore` 排除依赖、构建产物、日志、环境变量、私钥与证书容器、微信开发者工具私有配置、AI 工具工作目录、本地笔记和已废弃后端。`project.config.json`、`miniprogram/config/env.ts` 和管理端 API 地址属于应用配置，需随目标环境核对；AppID 与云环境 ID 不作为密钥管理。

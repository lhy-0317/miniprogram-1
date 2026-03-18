# 智惠本草小程序

基于微信云开发的智慧环保小程序，为用户提供扫码取纸、趣味答题、AR本草识别等服务。

## 项目简介

智惠本草小程序是一款集环保公益与健康科普于一体的微信小程序。通过扫码取纸功能帮助用户应急用纸，通过趣味答题传播中医药文化，通过AR识别让用户了解本草知识。

## 技术栈

- **前端框架**：微信小程序原生开发 + TypeScript
- **UI组件库**：TDesign小程序组件库
- **样式方案**：Tailwind CSS
- **后端服务**：微信云开发（CloudBase）
- **云数据库**：CloudBase Database
- **云存储**：CloudBase Storage
- **云函数**：CloudBase Functions

## 项目结构

```
miniprogram-1/
├── admin/                    # 管理后台（Web端）
│   ├── index.html           # 仪表盘
│   ├── login.html           # 登录页
│   ├── users.html           # 用户管理
│   ├── coupons.html         # 优惠券管理
│   ├── quiz-records.html    # 答题记录管理
│   └── questions.html       # 题库管理
│
├── cloudfunctions/           # 云函数
│   ├── login/               # 用户登录
│   ├── getRandomQuestions/  # 获取随机题目
│   └── submitQuizRecord/    # 提交答题记录
│
├── docs/                    # 文档
│   ├── README.md           # 项目说明
│   └── prd.md              # 需求文档
│
├── miniprogram/            # 小程序源码
│   ├── pages/
│   │   ├── splash/         # 开屏页
│   │   ├── home/           # 首页（扫码取纸）
│   │   ├── quiz/           # 趣味答题
│   │   ├── ar/             # AR识别
│   │   ├── profile/        # 个人中心
│   │   ├── edit-profile/   # 编辑资料
│   │   ├── quiz-history/   # 答题历史
│   │   ├── usage-records/ # 使用记录
│   │   ├── ar-records/    # AR识别记录
│   │   ├── settings/       # 设置
│   │   └── feedback/       # 帮助与反馈
│   │
│   ├── assets/             # 静态资源
│   │   └── icons/          # 图标
│   │
│   ├── utils/              # 工具函数
│   ├── app.json           # 小程序配置
│   ├── app.ts             # 小程序入口
│   └── app.wxss           # 全局样式
│
└── prototype/              # 原型图
    ├── index.html
    ├── home.html
    ├── profile.html
    ├── quiz.html
    ├── ar.html
    └── splash.html
```

## 功能模块

### 1. 扫码取纸
- 微信扫码识别设备
- 支付成功后展示出纸动画
- 使用记录自动保存

### 2. 趣味答题
- 随机抽取5道题目
- 答题正确反馈（振动+视觉）
- 每连续答对5题获得优惠券
- 答题历史记录

### 3. AR本草识别
- 摄像头实时预览
- 植物图像识别
- 识别记录保存与展示

### 4. 个人中心
- 微信一键登录
- 个人信息编辑（头像、昵称）
- 优惠券管理
- 使用记录查看
- 答题历史查看

### 5. 设置
- 消息通知开关
- 优惠券到期提醒
- 隐私政策查看
- 用户协议查看
- 清除缓存
- 退出登录

## 快速开始

### 环境要求
- Node.js 16+
- 微信开发者工具
- 微信小程序AppID

### 安装部署

1. **克隆项目**
```bash
git clone <repository-url>
cd miniprogram-1
```

2. **安装依赖**
```bash
npm install
```

3. **配置云开发**
- 登录 [微信开发者工具](https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html)
- 创建云开发环境（环境ID: `cloud1-6gqgdhv6f2059125`）
- 在云开发控制台创建以下数据库集合：
  - `users` - 用户信息
  - `coupons` - 优惠券
  - `quiz_records` - 答题记录
  - `quiz_questions` - 答题题库
  - `usage_records` - 使用记录
  - `ar_records` - AR识别记录
  - `feedback` - 用户反馈

4. **上传云函数**
```bash
# 在微信开发者工具中右键cloudfunctions文件夹，选择"上传并部署"
```

5. **开启匿名登录**
- 进入云开发控制台 → 身份认证 → 登录方式 → 开启匿名登录

### 启动管理后台

```bash
cd admin
python -m http.server 8080
# 访问 http://localhost:8080
```

## 数据库集合说明

| 集合名称 | 说明 | 主要字段 |
|---------|------|---------|
| users | 用户信息 | nickName, avatarUrl, savedPaper, quizCount |
| coupons | 优惠券 | amount, type, expireDate, status |
| quiz_records | 答题记录 | questionId, isCorrect, answerTime, createTime |
| quiz_questions | 答题题库 | question, options, correct, explanation |
| usage_records | 使用记录 | type, title, description, paperCount |
| ar_records | AR识别记录 | herbName, herbInfo, imageUrl, confidence |
| feedback | 用户反馈 | type, content, images, contact, status |

## 开发规范

- 使用 TypeScript 进行开发
- 遵循 TDesign 组件库使用规范
- 云数据库操作使用 `wx.cloud.database()`
- 异步操作使用 Promise/async-await

## 注意事项

1. **隐私合规**：用户需主动勾选同意隐私政策方可登录
2. **数据安全**：数据库安全规则根据需求设置
3. **域名配置**：在微信公众平台配置HTTPS域名

## 许可证

MIT License

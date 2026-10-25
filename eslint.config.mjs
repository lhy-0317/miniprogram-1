// ESLint 扁平配置（v9）
//
// 三个分区：
//   1. miniprogram 下所有 .ts —— 小程序端：推荐规则 + 禁未使用变量
//   2. cloudfunctions 下所有 .js —— 云函数：Node 全局 + 基础规则
//   3. admin 下所有 .js —— 管理后台：浏览器全局
//
// 注意：块注释内不要书写含星号斜杠的 glob 模式（会被提前闭合）。
//
// 运行：npm run lint（当前只 lint miniprogram，云函数/后台可按需扩展）

import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  // 全局忽略：构建产物、第三方包、已废弃后端
  {
    ignores: [
      'node_modules/**',
      'miniprogram/miniprogram_npm/**',
      'back/**',
      'cloudbase/**',
      '**/*.js', // 编译产物（pages 下的 .js 由 .ts 生成）
    ],
  },

  // 小程序端 TypeScript
  {
    files: ['miniprogram/**/*.ts', 'typings/**/*.d.ts'],
    extends: [...tseslint.configs.recommended],
    languageOptions: {
      // globals 包无微信小程序环境，用 browser + 手动补充 wx/App/Page/Component 等
      globals: {
        ...globals.browser,
        wx: 'readonly',
        App: 'readonly',
        Page: 'readonly',
        Component: 'readonly',
        Behavior: 'readonly',
        getCurrentPages: 'readonly',
        getApp: 'readonly',
        requirePlugin: 'readonly',
      },
      parserOptions: {
        ecmaVersion: 2020,
        sourceType: 'module',
      },
    },
    rules: {
      // 项目约定：TS 类型由 tsc 把关，此处只关 vibe 类噪音
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      // 未使用变量报错——本轮历史上真实踩过的坑（未声明变量、遗留引用）
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-console': 'off',
    },
  },

  // 云函数 CommonJS
  {
    files: ['cloudfunctions/**/*.js', 'scripts/**/*.js'],
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: { ecmaVersion: 2022, sourceType: 'commonjs' },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },

  // 管理后台（浏览器全局）
  {
    files: ['admin/**/*.js'],
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: { ecmaVersion: 2020, sourceType: 'script' },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  }
);

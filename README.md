# LP Simulator

独立的集中流动性 LP 价格与资产价值模拟器，使用 React、Ant Design、ECharts 和 viem。

支持手动模拟及 Uniswap V3 / V4、Aerodrome / Slipstream NFT 仓位导入。内置 Base、Ethereum、Arbitrum、Optimism、Polygon、BNB Chain 和 Avalanche 的网络选项；可用协议取决于各链部署。支持入场价、历史加仓读取、区间标记、双轴缩放及价格情景比较。

## 本地开发

需要 Node.js 22.12+、npm 10+。

```sh
npm ci
npm run dev
```

打开 http://127.0.0.1:5174/ 。

```sh
npm run check
npm run build
npm run preview
```

`npm run check` 包括格式、类型、现有单元测试和生产构建。构建输出为 `dist/`，无机器人、钱包连接、签名或交易执行服务。

## 云部署

这是静态站点。连接 GitHub 仓库到支持 Vite 的静态托管服务时，设置：

- 安装命令：`npm ci`
- 构建命令：`npm run build`
- 发布目录：`dist`
- Node.js：22

也可在容器云或服务器运行：

```sh
docker build -t lp-simulator .
docker run --rm -p 8080:80 lp-simulator
```

Docker 使用 Nginx 托管构建产物，不需要运行 Vite 开发服务器。当前没有绑定域名、云平台或自动部署凭据。

### RPC 与数据

线上由浏览器直接访问用户选择的公开 RPC，因此节点必须支持浏览器跨域请求（CORS）和所需历史读取。部分免费节点限制历史区块或日志范围，必要时切换支持 archive 的 RPC。仅本机开发/预览为 Base 默认节点提供固定上游的只读代理；该 localhost 代理不是公网服务。

RPC 地址会出现在浏览器中，不能把服务端私钥或保密 API 密钥填入前端。仓位和模拟参数保存在当前浏览器的 localStorage，不上传应用服务器；更换域名或本地端口后不会自动迁移旧站点参数。

## GitHub

目录可独立作为 Git 仓库上传，CI 配置位于 `.github/workflows/ci.yml`。上传前检查 `git diff --cached`，不要加入 `.env`、凭据或个人运行数据。`package-lock.json` 应保留在版本控制中。

## 来源

从 Range Pilot 的 LP 模拟器独立拆出，保留必要的链读取工具及其测试；没有复制 Range Pilot 的自动化服务、合约部署产物或钱包交易模块。项目源码的发布许可证尚未指定；第三方依赖继续遵循各自许可证。

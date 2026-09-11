# LP Simulator

- Independent React + Ant Design + ECharts simulator. Chinese UI.
- Keep manual and NFT modes working, and preserve input drafts across mode switches.
- Only read public chain data. Never add wallet signing, transaction execution, or robot services to test UI changes.
- Do not put secrets or real service configuration in frontend code, logs, or commits.
- Keep package-lock.json under version control. Run npm run check before delivery.
- Production is a static build in dist; localhost RPC middleware must not become an unrestricted public proxy.
- Do not push, publish or deploy without explicit user instructions.

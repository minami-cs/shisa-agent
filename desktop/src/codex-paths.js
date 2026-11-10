// Finder 실행에서도 Codex·ChatGPT 앱에 포함된 Codex CLI를 찾는다.
export function bundledCodexDirs(home) {
  const roots = ['/Applications', ...(home ? [`${home}/Applications`] : [])];
  return roots.flatMap((root) => [
    `${root}/Codex.app/Contents/Resources`,
    `${root}/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS`,
  ]);
}

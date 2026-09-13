# Contribuir

Mudanças pequenas, verificáveis e bem explicadas são preferíveis a promessas grandes.
Abra uma issue antes de mudanças amplas de arquitetura. Preserve a licença MIT e
os avisos de origem; qualquer código de terceiros precisa de licença e atribuição.

1. Crie branch/fork, configure Node.js 22+ e leia README/SECURITY/ARCHITECTURE.
2. Escreva teste de regressão para a causa real; não remova verificações para obter PASS.
3. Execute `npm run check` (sintaxe e lint) e `npm test` sem credenciais reais.
4. Atualize documentação/CHANGELOG; revise os arquivos e regenere PUBLIC_FILES.json
   com `node scripts/update-manifest.mjs`; rode `npm run check:release` e `npm run check:public`.
5. Abra PR indicando problema, solução, limites, testes executados e bloqueios externos.

Não acrescente adapters redundantes quando OpenAI-compatible funcionar. Não marque
modelo/capability como validado só porque consta em um catálogo. Não adicione telemetry,
gastos automáticos ou dependências sem justificar e documentar a decisão.

CI deve ser determinística, sem contas cloud, e cobrir erros/concorrência. Novos
protocolos exigem testes de contrato. Mudanças de persistência precisam de plano
de migration/backup/rollback e não podem apagar memórias existentes silenciosamente.

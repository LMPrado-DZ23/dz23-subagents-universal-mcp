# Changelog

## 2.2.5 — 2026-09-12 — hardening de orquestração e limites

- Contexto persistido e saídas de modelos são enviados como dados não confiáveis;
  papéis agora usam enum estrito e QA/DevOps não podem alegar execução de ações.
- `swarm_run` usa o primeiro alvo como principal e os seguintes apenas como failover,
  evitando distribuir trabalho ao modelo de fallback quando o principal está saudável.
- Limites configuráveis para fila, resposta HTTP, frame stdio, outputs persistidos,
  journal e checkpoints; concorrência e quantidade de agentes possuem tetos.
- Modo HTTP desativado por padrão e condicionado a opt-in explícito.
- Locks de memória toleram erros transitórios do Windows sem remover exclusão mútua.
- Regressões cobrem papéis arbitrários, contexto não confiável, limite de resposta
  vazia, evento excessivo e preferência do alvo principal. Smoke real no Windows/
  Node 24 validou os sete papéis e o reviewer integrador usando o modelo cloud
  `deepseek-v4-flash:cloud` por meio do daemon Ollama local.

## 2.2.4 — 2026-09-12 — paralelismo verificável e distribuição de workers

- Corrigido round-robin em `swarm_run`: papéis usam alvos elegíveis distintos
  antes de reutilizar um alvo, mantendo a ordem da rotação e os limites existentes.
- Testes não dependem mais de respostas falsas durarem 30/40 ms. Barreiras de
  Promises mantêm chamadas abertas até observar simultaneidade e filas. Watchdogs
  detectam travamentos; o tempo decorrido não é critério de aprovação.
- Regressão com journal deliberadamente lento; checagem de distribuição com
  reutilização/cooldown; limites globais/por alvo e liberação em erro preservados.
- `PUBLICAR_WINDOWS.cmd` executa o publicador na própria pasta, sem digitar caminho.
  Requer Node/Git/gh instalados e login local; qualquer teste falho ainda bloqueia push.
- Sem migração de memória, alteração de APIs/chaves ou redução de guardas.
- Consulte `docs/VALIDATION.md`: validação local Linux, sem alegar Windows/Node 24
  ou GitHub Actions aprovados antes de serem executados nesses ambientes.

## 2.2.3 — 2026-09-12 — preparação open-source (engineering preview)

### Publicação e documentação
- Licença MIT original preservada; README PT/EN, contribuição, conduta, segurança,
  suporte, inventário de componentes e roadmap adicionados.
- Publicação primeira vez via GitHub CLI com conta verificada, allowlist/hash,
  scanner de padrões, proteção contra sobrescrita e verificação do commit remoto.
- Nenhum `.env` privado no código público; instaladores criam a cópia local.
- CI configurada para Linux/Windows e Node 22/24; ainda não executada no GitHub.
- Limites reais documentados: workers textuais, sem shell/worktrees automáticas,
  sem OAuth/RBAC/multitenancy/Vault, sem promessa de custo zero ou host universal.

### Correções de runtime
- Seleção explícita agora respeita elegibilidade; `paid` e `low-cost` bloqueados
  com ALLOW_PAID=false (antes era possível contornar via target explícito).
  Alvos explícitos também respeitam a lista DZ23_ROTATION quando definida.
- Limites simultâneos globais e por provider:model agora aplicados por processo.
- IDs de projeto/missão inválidos são rejeitados, não silenciosamente normalizados.
- Arquivos/dirs de memória novos com permissões restritas quando suportadas.
- HTTP exige token em bind não local, valida Host/Origin, trata JSON inválido,
  retorna 202 em notificações e 405 no GET/DELETE MCP sem SSE.
- Erros de API não devolvem corpo bruto; secret files ilegíveis falham explicitamente.
- URLs de provider rejeitam credenciais embutidas/query/fragmento.
- Flags de capabilities agora descrevem a superfície textual realmente exposta.
- IDs de modelo não comprovados para novas integrações passam a configuração explícita.

### Compatibilidade / atualização
- Baseline passa para Node 22+. IDs anteriormente normalizados devem ser referidos
  pelo nome seguro já gravado em disco; faça backup antes de qualquer ajuste manual.
- Non-loopback HTTP precisa de token 32+ e hosts/origins explicitamente autorizados.
- Mixed/free-tier continuam dependentes do plano do fornecedor: o guard não é um
  teto financeiro. Exemplo padrão usa somente o endpoint local.
- Nenhuma migração, limpeza de estado ou alteração de outros projetos foi executada.

## 2.2.2 — base recebida

Carregamento do .env relativo à instalação e geração de snippets com caminhos reais.
A suíte de 14 testes da base foi reexecutada antes das mudanças desta preparação.

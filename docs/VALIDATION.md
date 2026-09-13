# Validação

## v2.3.0 — conformidade MCP, segurança HTTP, observabilidade, orçamento e memória v2

Data: 2026-09-13. Ambiente executado: Windows 11, Node.js v24.16.0.
Branch `feat/v2.3.0-operability`, base `37ef590` (v2.2.5 publicada no GitHub).

### Baseline antes das mudanças (v2.2.5)

| Comando | Resultado |
| --- | --- |
| `npm run check` | 20 arquivos JavaScript verificados |
| `npm test` | 33 aprovados, 0 falhas |
| `npm run check:release` | PASS, 61 arquivos |

### Gates da candidata

| Comando | Resultado observado |
| --- | --- |
| `npm run check` | 61 arquivos JavaScript, lint com 0 problemas |
| `npm test` | 123 aprovados, 0 falhas, 0 cancelados, 0 ignorados (16,1 s) |
| `npm run check:release` | PASS, versão 2.3.0, 105 arquivos, nenhum padrão de segredo |
| `npm run check:public` | PASS, 106 arquivos rastreados, 105 listados mais o próprio manifesto |
| `git diff --check` | sem problemas |
| `npm run test:coverage` | linhas 95,66 %, branches 84,76 %, funções 91,93 % (relatório, sem limite mínimo) |

Cada fase foi commitada separadamente só depois de `npm run check` e `npm test` passarem.

### Smoke em processo real

**HTTP** (`node src/index.js --http`, loopback, token sintético de 44 caracteres, provider apontando
para uma porta local fechada, estado em diretório temporário):

| Verificação | Resultado |
| --- | --- |
| `/healthz` sem token / com token | 401 / 200 |
| `initialize` com 2025-11-25 | 200, `protocolVersion` 2025-11-25, `serverInfo.version` 2.3.0 |
| `tools/list` | 11 ferramentas, incluindo `verify_model` |
| `delegate` com prompt vazio, header 2025-06-18 | JSON-RPC `-32602`, `field: prompt`, `reason: must not be empty` |
| Mesmo pedido, header 2025-11-25 | `isError: true`, `code: invalid_arguments` |
| `delegate` com provider inacessível | `all_providers_failed`, duas tentativas `provider_unavailable` (retry) |
| Segundo `delegate` | `no_providers` (alvo em cooldown de 30 s) |
| Terceiro `delegate` | HTTP 429, `Retry-After: 30`, JSON-RPC `-32001`, sem chamada ao provider |
| `/metrics` com token | contadores de ferramentas, falhas, retries, rate limit, tokens e uso |
| Logs em stderr | 10 linhas, todas JSON válido, token ausente |

**Cliente MCP oficial** (`@modelcontextprotocol/sdk` 1.30.0, instalado com `--ignore-scripts` em
diretório temporário descartável, fora do repositório e sem entrar nas dependências do projeto):

| Transporte | Resultado |
| --- | --- |
| stdio (`StdioClientTransport`) | `connect` ok, `serverInfo` 2.3.0, 11 ferramentas, `project_init`, `memory_checkpoint` e `mission_status` ok, argumento inválido como `isError`/`invalid_arguments`, provider inacessível como `all_providers_failed`, ferramenta inexistente como `McpError -32602`, `ping` ok |
| Streamable HTTP (`StreamableHTTPClientTransport`, token Bearer) | Protocolo negociado 2025-11-25 e os mesmos resultados; GET sem SSE tolerado pelo cliente; token ausente dos logs |

**CLI em cópia da memória real 2.2.x** (cópia temporária de `~/.dz23-subagents`, 1,4 MB, removida
depois; a memória original não foi lida por escrita nem alterada): `doctor` sem falhas;
`missions list` leu 23 missões de 9 projetos (10 `done`, 13 `active`) com migração para o schema 2;
`memory repair` (dry run) não encontrou problemas.

### Defeitos encontrados durante a implementação e corrigidos pela causa raiz

| Defeito | Reprodução | Correção e evidência |
| --- | --- | --- |
| No Windows, `rename` de `state.json` falhava com EPERM enquanto outra operação do mesmo processo lia o arquivo; um worker falhava depois de uma chamada bem-sucedida (o defeito já existia na 2.2.5, com menor frequência) | Swarm com orçamento concorrente: 2 de 5 execuções falharam; teste com leitores contínuos | Serialização de leituras/escritas do processo por projeto e retry de erros transitórios; 0 falhas em 30 execuções repetidas e regressões em `test/memory-io.test.js` |
| Erro inesperado de worker devolvia a mensagem crua, incluindo caminho absoluto do estado | Mesma reprodução | Falhas inesperadas viram `internal_error` genérico; teste dedicado |
| Uma lista longa de decisões podia consumir todo o orçamento de contexto e esconder invariantes | Teste de contexto com lista extensa | Alocação em duas passagens com teto por seção; teste verifica critérios e invariantes preservados |
| `verify_model` aceitava `auto` como alvo explícito na validação | Teste de schema | Padrão com lookahead negativo; teste |
| Peso de rate limit maior que a capacidade tornava a ferramenta impossível sem aviso | Teste do limitador | `config`/`doctor` reportam erro; teste |
| Mensagem "check quota" de limite por minuto seria classificada como quota esgotada (sem retry) | Tabela de classificação | Padrão de quota restrito; teste de taxonomia |

### Cobertura dos critérios de aceite por testes

| Critério | Onde |
| --- | --- |
| Validação MCP (obrigatório, tipo, enum, limites, campo desconhecido, prompt vazio/grande, defaults) | `test/schema.test.js` |
| Erros JSON-RPC, `id` 0/string/null, notificações, negociação de versão, paridade stdio/HTTP | `test/jsonrpc.test.js` |
| Token por arquivo, escopos, bind inseguro, rate limit 429 sem chamada, limites HTTP, shutdown | `test/http-security.test.js` |
| `request_id` em logs/journal/resultados, redação de segredos, métricas, stdio | `test/observability.test.js` |
| Taxonomia de erros, retry, Retry-After, failover, sem failover para requisição inválida | `test/provider-errors.test.js` |
| Orçamento disponível/excedido, uso do provider, sem uso, custo desconhecido, concorrência, retry, revisor | `test/budget.test.js` |
| Estratégias, diversidade efetiva/observada, revisor distinto, consenso e síntese | `test/routing.test.js` |
| `verify_model`, flags de inventário, capabilities `unknown` | `test/verify.test.js` |
| Migração de schema, integridade, locks órfãos, journal, contexto estruturado, reparo | `test/memory-v2.test.js`, `test/memory-io.test.js` |
| CLI, códigos de saída, confirmações | `test/cli.test.js` |
| Lint e auditoria de arquivos públicos | `test/tooling.test.js` |

### Limitações desta validação

- O SDK MCP oficial foi executado manualmente nesta validação, mas não faz parte da CI (o projeto não
  tem dependências); a CI verifica o contrato com fixtures JSON-RPC e processos reais stdio e HTTP.
- Nenhum provider cloud ou real foi chamado. `health_check`, `verify_model` e delegação foram
  exercitados com servidores locais falsos ou portas fechadas.
- Docker e compose não foram executados.
- GitHub Actions está configurado; aprovação só vale depois da execução remota.
- O shutdown gracioso foi verificado no teste em processo. No Windows, `kill('SIGTERM')` encerra o
  processo filho sem executar handlers, então não foi observado em processo separado.
- Rate limit, orçamento e cooldown são por processo; concorrência entre processos não foi testada.
  Locks em sistemas de arquivos de rede não foram testados.

## v2.2.5 — hardening e integração real

Data: 2026-09-12. Ambiente executado: Windows, Node.js v24.16.0.
Base: repositório público `main` no commit `458d4067e008c2a21da69cc3f9c07a32dd12b1d9`,
confirmado byte a byte contra o ZIP v2.2.4 auditado.

- `npm run check`: 20 arquivos JavaScript verificados.
- `npm test`: 33 aprovados, 0 falhas, 0 ignorados.
- MCP stdio: `initialize` e `tools/list` reais; dez ferramentas descobertas.
- `health_check`: `deepseek-v4-flash:cloud` e `qwen2.5:0.5b` responderam via
  endpoint OpenAI-compatible do daemon Ollama local; o primeiro é executado na
  nuvem do Ollama e o segundo localmente.
- `swarm_run`: sete papéis (`architect`, `backend`, `frontend`, `security`, `qa`,
  `devops`, `reviewer`) mais integração final concluíram com conteúdo não vazio no
  DeepSeek cloud em 22,988 s. O teste usou somente dados sintéticos.

O scanner nativo profundo não iniciou porque o ambiente do assistente não forneceu
perfil gerenciado de filesystem ao worker. A revisão foi concluída por inspeção
estática manual, validação do manifesto/hash, Microsoft Defender sem detecções,
testes unitários e smokes reais. Isso não equivale a pentest independente.

## Histórico v2.2.4

Data: 2026-09-12. Ambiente executado: Linux x86_64, Node.js v22.16.0.
Base: `DZ23-Subagents-MCP-v2.2.3-OPEN-SOURCE.zip`.
SHA-256 da base: `06a648b3e06f51dba87691323d1bb3b81a31206094652e2ac61c4fafb8c166fc`.
O ZIP de origem não foi alterado. A correção foi feita em uma cópia isolada;
nenhuma configuração, memória ou projeto da máquina do usuário foi acessado.

O log fornecido pelo usuário mostrou 24/25 testes aprovados em Windows, Node 24.16.0,
e falha `expected real parallelism` em `test/router.test.js` da versão 2.2.3. A falha foi
reproduzida com atraso serializado no journal e corrigida com barreiras de Promises que
observam chamadas simultâneas, sem depender de janelas de 30/40 ms. Mutações descartáveis
(limite global de uma chamada, limite por alvo desabilitado, todos os workers no primeiro
alvo) foram detectadas pelos testes. O pacote extraído foi retestado em pasta com espaços,
com 27 testes aprovados, dry-run do publicador e smoke stdio real.

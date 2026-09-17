# Validação

## v4.2.0 — clientes reais, roteamento adaptativo, grafos, painel e sandbox

Data: 2026-09-17. Branch `feat/4.2.0` a partir da tag `v4.1.0`. Nenhum provider real foi chamado nos testes
automatizados; o teste de cliente real usou a instalação 4.1.0 da máquina do mantenedor.

### Clientes reais

| Cliente | O que foi executado | Resultado |
| --- | --- | --- |
| MCP Inspector 2.7.0 (CLI oficial) | `tools/list`, `resources/list`, `resources/templates/list`, `resources/read`, `prompts/list`, `prompts/get` contra a 4.1.0 instalada | Tudo funcionou (19 ferramentas, 97 resources, 3 prompts) |
| MCP Inspector 2.7.0 | `npm run check:inspector` na 4.2.0 (também em CI, Linux e Windows) | 7/7 |
| Codex CLI 0.154.0-alpha.6.2 (`codex exec`) | Pedido para listar e ler resources da MCP | O cliente não oferece ferramentas de resources ao modelo (`RESOURCE_TOOLS_UNAVAILABLE`) |
| Codex CLI 0.154.0-alpha.6.2 | Chamar `handoff_export` e `mission_claim` | As duas chamadas concluíram pela MCP; o modelo do cliente não terminou a terceira etapa |
| Claude Code 2.1.201 (`claude -p`) | Mesmo pedido de resources | Não executado: a autenticação do modo não interativo estava sem crédito de API nesta máquina |

Conclusão aplicada nesta versão: resources e prompts MCP continuam disponíveis, e o mesmo conteúdo existe como
ferramentas (`mission_list`, `playbook_get`) para clientes que só expõem tools.

### Gates

| Comando | Resultado observado |
| --- | --- |
| `npm run check` | 95 arquivos JavaScript, lint com 0 problemas |
| `node --test` (Windows 11, Node 24) | 249 testes: 248 aprovados, 0 falhas, 1 ignorado (modo Docker: daemon indisponível), em duas execuções |
| `node --test` (Linux no WSL2, Node 22) | 247 aprovados, 0 falhas, 2 ignorados (sistema de arquivos com diferença de maiúsculas; e o modo Docker quando a imagem não pode ser baixada, pois o WSL desta máquina não alcança o Docker Hub), em duas execuções |
| `npm run check:release` / `npm run check:public` | PASS, versão 4.2.0 |
| `npm run check:inspector` | 7/7 |
| Smoke com processo real (stdio + comando `dashboard`) | 13/13: 27 ferramentas com workspace e sandbox ligados, `routing_explain`, `cost_estimate`, plano inválido recusado, `mission_list`, `playbook_get`, `patch_validate` aprovando a correção numa cópia com a árvore original intacta, comando fora da lista recusado, página do painel com CSP, API do painel recusando sem token e respondendo com token |

### Revisão independente de segurança

Uma revisão adversarial pelo próprio DZ23 MCP (modelo gratuito) do sandbox e do painel apontou que o diff é código executado pelo comando de teste. Consequências aplicadas antes da publicação: o modo padrão passou a ser `docker` (`--network none`), o modo `process` exige `DZ23_SANDBOX_MODE=process` explícito e diffs com symlinks ou submódulos são recusados. Nenhum problema foi encontrado no painel.

### Não validado

- Modo Docker do sandbox nesta máquina (daemon não iniciou; no WSL a imagem não pôde ser baixada). O teste roda
  onde houver Docker com acesso ao registro, como os runners Linux da CI.
- Resources e prompts dentro do Claude Code interativo.
- Roteamento adaptativo com provedores reais e cabeçalhos de cota reais (validado com respostas simuladas).
- macOS.

## v4.1.0 — auditoria da entrega externa e correções

Data: 2026-09-17. Branch `feat/4.1.0` a partir da tag `v4.0.0`. A implementação inicial veio de um
agente externo (zip `dz23-subagents-universal-mcp-4.1.0`), registrada sem alterações no commit
`import: Manus 4.1.0 delivery as received`. Nenhum provider real foi chamado: testes e sondas usam
providers falsos locais.

### Processo

1. A entrega passava nos gates do projeto (`npm run check`, 219 testes, `check:release`,
   `check:public`), mas a leitura do código e sondas de comportamento pelo servidor MCP mostraram
   defeitos que os testes da entrega não cobriam.
2. Cada defeito virou um teste em `test/audit-410-tools.test.js` ou `test/audit-410-missions.test.js`.
   Os 18 testes foram executados contra a entrega recebida e **todos falharam**, pelos motivos
   esperados. Destaques:
   - repositório com `core.fsmonitor` apontando para um script: o script foi executado por
     `git_readonly`;
   - `delegate` devolveu 12 000 de 20 000 caracteres sem que o cliente pedisse;
   - `.npmrc` foi lido;
   - `timeoutMs = 12345678` virou `[PHONE_REDACTED]`;
   - evidência de teste anterior ao job concluiu a missão;
   - `mission_cancel` transformou um job terminado em `cancelled`;
   - seis reivindicações simultâneas de trava não garantiam vencedor único.
3. Correções no commit `fix: audit of the 4.1.0 delivery` (lista completa no CHANGELOG). Depois delas
   os 18 testes passam, junto com os testes da entrega.

### Gates

| Comando | Resultado observado |
| --- | --- |
| `npm run check` | 87 arquivos JavaScript, lint com 0 problemas |
| `node --test` (Windows 11, Node 24) | 238 aprovados, 0 falhas, em duas execuções seguidas |
| `node --test` (Linux no WSL2, Node 22) | 237 aprovados, 0 falhas, em duas execuções; 1 ignorado de propósito (sistema de arquivos sem diferença de maiúsculas) |
| `npm run check:release` | PASS, versão 4.1.0, nenhum padrão de segredo |
| `npm run check:public` | PASS |
| Smoke com processo real (stdio, sem provider) | 13/13: 22 ferramentas com `DZ23_WORKSPACE_ROOTS`, leitura permitida e `.env` recusado, busca, resources, prompt, trava com `mission_busy`, handoff e log de auditoria sem chaves |
| Smoke da 4.0.0 no mesmo processo | 14/15; a única diferença é a contagem de ferramentas, que agora inclui as novas (esperado) |

### Não validado

- MCP Inspector e tasks do MCP (não anunciadas).
- Clientes reais (Claude Code, Codex) usando resources e prompts.
- Providers reais, Ollama/LM Studio/vLLM, OmniRoute.
- macOS; `git_readonly` com Git LFS e repositórios muito grandes.
- Detecção de dados pessoais além dos formatos listados em `docs/TOOLS.md` (é heurística, não DLP).

## v4.0.0 — política de custo, failover, cancelamento e stdio concorrente

Data: 2026-09-16. Ambiente executado: Windows 11 com Node.js 24. Branch `fix/v3.1.0-hardening` (a
candidata começou como 3.1.0 e virou 4.0.0 por causa das mudanças incompatíveis). Nenhum provider real
foi chamado: os testes e o smoke usam fixtures e um provider falso local.

### Processo

1. Revisão da 3.0.0 publicada por três auditores independentes (engenharia, segurança e produto/DX).
   Os achados HIGH da primeira rodada (política de custo que deixava passar provedores `mixed`,
   credenciais genéricas herdadas de outras ferramentas, respostas pagas perdidas por falha de memória,
   ausência de cancelamento, stdio serial) foram corrigidos com `test/hardening-policy.test.js`,
   `test/hardening-runtime.test.js` e `test/cli-diagnostics.test.js`.
2. Segunda rodada sobre a candidata corrigida. Achados e correção, cada um com teste em
   `test/hardening-audit.test.js`:
   - HIGH: falha de autenticação de um harness era compartilhada e tirava o provider dos outros; agora só
     tipos transitórios são compartilhados.
   - Cancelamento burlava o orçamento; agora a chamada cancelada é cobrada pela reserva.
   - `Retry-After` sem limite permitia cooldown de anos; limitado a 1 hora.
   - `GET /api/discover` contatava provedores com cache vazio; agora só lê o cache.
   - Nomes sem ponto e `.local` eram tratados como rede privada; agora exigem `DZ23_PRIVATE_HOSTS`.
   - `:free` liberava modelos em qualquer provider; agora só no OpenRouter. Modelos `:cloud` via adapter
     local passaram a `mixed`.
   - Nomes sem prefixo (`OLLAMA_BASE_URL`, `GROQ_MODEL`...) e `CLOUDFLARE_API_TOKEN` podiam redirecionar
     chaves; agora são ignorados ou tratados como credencial genérica.
   - Respostas de workers podiam forjar o fim do bloco no prompt do integrador; marcadores com nonce.
   - stdio: requisição cancelada na fila ainda rodava, fila sem limite, `id` duplicado aceito.
   - Classificador de contexto grande amplo demais; backoff ignorava cancelamento; consenso marcava
     "30 s" e "90 s" como concordância.
   - CRITICAL de produto: `DZ23_ROUTING_POLICY=ordered` (valor da 2.2.x em uso) impedia o servidor de
     iniciar; virou alias com aviso.
3. Os scripts de reprodução dos auditores foram executados de novo sobre a correção. Resultados:
   cancelamento durante backoff retorna em cerca de 115 ms sem listeners pendentes; falha de
   autenticação não aparece em `providers/status.json`; desconexão HTTP aborta a chamada e registra
   uso `failed/cancelled`; requisição stdio cancelada na fila não roda (crescimento de heap do cenário de
   carga caiu de 209 MB para 41 MB); chamada cancelada cobrada com 5272 tokens estimados; `http://gateway`
   recusado; divergências de número e de comparação detectadas.

### Gates

| Comando | Resultado observado |
| --- | --- |
| `npm run check` | 74 arquivos JavaScript, lint com 0 problemas |
| `npm test` (Windows, Node 24) | 212 aprovados, 0 falhas, em cinco execuções seguidas (cerca de 15 s cada) |
| `node --test` (Linux no WSL2, Node 22) | 211 aprovados, 0 falhas, em duas execuções; 1 ignorado de propósito (só vale em sistema de arquivos sem diferença de maiúsculas) |
| `npm run check:release` | PASS, versão 4.0.0, nenhum padrão de segredo |
| `npm run check:public` | PASS |
| `git diff --check` | sem problemas |
| Smoke com processo real (servidor stdio + provider falso) | 15/15 |

### Defeito de teste encontrado e corrigido

A bateria completa travava às vezes em `test/hardening-audit.test.js`. No teste de desconexão HTTP, a
limpeza do diretório temporário falhava (`ENOTEMPTY`) enquanto o servidor ainda gravava a tentativa
cancelada; com o hook falho, o servidor HTTP do teste não era fechado e o processo não terminava. O teste
agora espera essa gravação, fecha o servidor e a limpeza repete a remoção.

### Defeito de produto encontrado pela CI e corrigido

Na CI (Linux, Node 22), o teste de prazo falhava com `Promise resolution is still pending`:
`AbortSignal.timeout` não mantém o event loop vivo, então uma chamada que só esperava o prazo podia ser
descartada. O prazo de `delegate`, `consensus` e `swarm_run` passou a usar um timer comum, cancelado
quando a chamada termina.

### Não validado

- macOS.
- Docker, HTTP atrás de proxy TLS e provedores reais.
- `MCP_TOOL_TIMEOUT` do Claude Code e o comportamento do shim `.ps1` com `--`.

## v3.0.0 — auditoria independente em quatro rodadas e correções

Data: 2026-09-13. Ambientes executados: Windows 11 com Node.js v24.16.0 e Ubuntu (WSL2, ext4) com
Node.js v22.23.1. Branch `feat/v2.3.0-operability`, base `37ef590` (v2.2.5 publicada). A numeração 2.3.0
foi usada apenas na candidata interna abaixo e virou 3.0.0 por causa das mudanças incompatíveis.

### Processo

1. Candidata `788e8ff` (seção v2.3.0 abaixo) revisada por três auditores independentes que não viram
   os relatórios uns dos outros: arquitetura/engenharia, segurança/DevSecOps e produto/QA. Uma consulta
   de consenso com três modelos revisou decisões de protocolo e versão.
2. Rodada 1: 4 achados HIGH (checkpoints concorrentes perdiam dados, bloqueio de tokens válidos,
   ferramentas sobrescreviam o handoff do harness, comando desconhecido abria o servidor stdio), além de
   MEDIUM e LOW. Corrigidos em `8643c14` com `test/audit-fixes.test.js`.
3. Rodadas 2 e 3 (reverificação de `8643c14`): todos os HIGH confirmados como corrigidos; novos MEDIUM
   (fila cheia colocava alvo em cooldown, colisão de maiúsculas/minúsculas em registros existentes, lock
   de PID 1 em container reiniciado, missão no limite de tamanho cobrava antes de falhar, sockets
   silenciosos ocupavam conexões, erros de configuração que não saíam com 78). Corrigidos em `1457a5d`
   com `test/audit-round2.test.js` e `test/audit-round3.test.js`.
4. Rodada 4 (reverificação de `1457a5d`): um HIGH novo introduzido pela correção anterior (falha
   transitória ao ler `owner.json` na liberação deixava o lock preso até reiniciar o processo) e MEDIUM
   (checagem de maiúsculas quebrava IDs distintos em Linux, CLI apresentava ID com caixa trocada como
   memória corrompida, um byte por conexão ainda segurava sockets). Corrigidos em `8ba063f` com
   `test/audit-round4.test.js`, `test/audit-round4-cli.test.js` e `test/audit-round4-security.test.js`.
5. Reverificação de `8ba063f`: arquitetura e produto confirmaram as correções da rodada 4, sem novos
   CRITICAL, HIGH ou MEDIUM. Os LOW apontados pelo auditor de produto (`doctor` passava quando `--http`
   recusaria o token, `memory repair --json` com `applied: true` sem reparos, texto da tabela de
   variáveis) foram corrigidos em `7dda4ab` com `test/audit-round5.test.js`.
6. Resultado da auditoria de segurança sobre `8ba063f`: ver "Resultado final da auditoria".

### Gates em `7dda4ab`

| Comando | Resultado observado |
| --- | --- |
| `npm run check` | 68 arquivos JavaScript, lint com 0 problemas (Windows e Linux) |
| `npm test` (Windows, Node 24) | 169 aprovados, 0 falhas |
| `node --test` (Linux ext4 no WSL2, Node 22) | 168 aprovados, 0 falhas, 1 ignorado de propósito: o teste de ID com caixa trocada na CLI só se aplica a sistemas de arquivos que não diferenciam maiúsculas |
| Arquivos das rodadas 3, 4 e 5 isolados | aprovados em execuções seguidas |
| `npm run check:release` | PASS, versão 3.0.0, 112 arquivos, nenhum padrão de segredo (Windows e Linux) |
| `npm run check:public` | PASS, 113 arquivos rastreados, 112 listados mais o próprio manifesto (Windows e Linux) |
| `git diff --check` | sem problemas |
| `npm run test:coverage` | linhas 94,39 %, branches 84,79 %, funções 90,20 % (relatório, sem limite mínimo) |

A queda de cobertura em relação a `1457a5d` (96,03 % de linhas) é efeito de medição: os novos testes de
CLI importam `src/cli.js` no próprio processo, então o arquivo passou a entrar no relatório. Antes a CLI era
exercitada só em processos filhos, que não entram na cobertura. Os demais arquivos não perderam cobertura.

**Cliente MCP oficial** (`@modelcontextprotocol/sdk` 1.30.0, diretório temporário, `--ignore-scripts`,
fora do repositório): 17 de 17 verificações em stdio e Streamable HTTP em `7dda4ab` (e também em
`8643c14`, `1457a5d` e `8ba063f`). `serverInfo` 3.0.0, 11 ferramentas, `memory_checkpoint` devolvendo resumo,
`mission_status` com `state: null` para missão inexistente, `health_check` sem `confirm_billable`
recusado, `GET /api/health` 405 e `POST /api/health` sem confirmação 400 com `error.details.field`.

### Defeitos de teste encontrados e corrigidos

- O teste de conexões silenciosas falhava só quando o arquivo rodava isolado. Um diagnóstico mostrou
  que o servidor fechava o socket após 1 s como esperado; o cliente de teste estava em modo pausado e não
  emitia `end`/`close`. A correção foi no teste (`socket.resume()`), sem afrouxar a asserção.
- O teste de sonda de maiúsculas usava um diretório que já existia; passou a usar um subdiretório ainda
  inexistente, para verificar que nada é criado antes do diretório de estado existir.

### Resultado final da auditoria

| Auditor | Última verificação | Resultado |
| --- | --- | --- |
| Arquitetura/engenharia | `8ba063f` | Correções da rodada 4 confirmadas (liberação de lock com leitura falhando, sonda de maiúsculas, cache de IDs); nenhum CRITICAL, HIGH ou MEDIUM novo |
| Segurança/DevSecOps | `8ba063f` | Todas as correções confirmadas por medição no servidor (sockets silenciosos e gotejamento fechados, respostas não autenticadas encerram a conexão, endereço privado por IP, lock, custo da checagem de IDs); nenhum CRITICAL, HIGH ou MEDIUM novo |
| Produto/QA | `8ba063f`, com os LOW corrigidos em `7dda4ab` | Fluxos da CLI, stdio e HTTP confirmados como usuário; nenhum CRITICAL, HIGH ou MEDIUM novo |

Situação final: CRITICAL 0, HIGH 0, MEDIUM 0. Os itens LOW restantes estão em "Limitações conhecidas".

### Limitações conhecidas desta versão

- Sem limite de conexões por endereço (aplique no proxy reverso) e sem cota de disco ou de missões
  por projeto (use cota no volume e escopos restritos).
- Um provider local apontado para um endereço público continua elegível com o modelo configurado, sem
  `DZ23_ALLOW_PAID`. Um gateway local em loopback ou rede privada que repassa para nuvens pagas também
  continua isento da regra de modelo padrão; use `DZ23_ROTATION` nesses casos.
- Alguns erros de configuração de enum interrompem na primeira ocorrência em vez de listar todos;
  o servidor sai com 78 nos dois casos.
- `consensus` registra o último revisor (`delegate`) em `last_tool_handoff`.
- Nomes de host sem ponto (por exemplo `ollama`) contam como endereço privado; um domínio de busca DNS
  poderia resolver um nome assim para um host público. Só o operador define esses endereços.
- A liberação de lock trata como próprio um `owner.json` ilegível após cinco tentativas; apagar o lock de
  outro processo exigiria, ao mesmo tempo, essa falha e uma tomada do lock.
- Depois de renomear um diretório de missão só na caixa, fora do servidor, o mesmo processo pode aceitar
  o nome antigo até reiniciar.
- O guard de publicação é heurístico (por exemplo não recusa `.aws/credentials` ou `*.ppk`); a lista
  auditada `PUBLIC_FILES.json` continua sendo a barreira principal.
- Continuam valendo as limitações da validação v2.3.0 abaixo: nenhum provider real chamado, Docker
  não executado, contadores por processo, locks em sistemas de arquivos de rede não testados.

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

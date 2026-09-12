# Validação

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

## Incidente e reprodução

O log fornecido pelo usuário mostra 24/25 testes aprovados em Windows, Node 24.16.0,
e falha `expected real parallelism` em `test/router.test.js:59` da versão 2.2.3.
O publicador parou na regressão, antes das chamadas GitHub/criação de Git previstas
adiante no script. A falha não deve ser contornada desabilitando esse gate.

Nesta execução, a base 2.2.3 passou 25/25 no Linux sem atraso artificial. A mesma
assertion foi reproduzida como falha ao inserir, somente no ambiente de teste,
100 ms de atraso serializado na gravação dos eventos `agent_attempt`.
O teste original mantinha as chamadas falsas abertas por apenas 40 ms, de modo
que o resultado dependia da rapidez de preparação dos outros workers. Essa é uma
reprodução controlada; não é alegação de ter executado Windows neste ambiente.

A revisão encontrou também um defeito independente no runtime: o vetor de slots
repetia o primeiro alvo antes de incluir o segundo. Três papéis podiam ir para p1,
p1, p1, embora o nome do teste afirmasse que seriam providers diferentes. Uma
assertion adicional reproduziu esse erro antes da correção de `core.js`.

## Correções e evidências

- `swarm_run` distribui papéis em round-robin pelos alvos elegíveis antes de reutilizar
  um alvo. O limiter existente continua aplicando limites globais e por provider:model.
- Barreiras de Promises mantêm chamadas abertas até observar três chamadas em voo,
  nenhuma finalizada e os três alvos esperados. Só depois as respostas são liberadas.
- O reviewer só inicia após os workers; três saídas e a integração são persistidas.
- Teste com apenas um provider comprova três chamadas ativas e duas submissões na
  fila, antes de liberar as respostas; os cinco workers e o reviewer concluem.
- A regressão de limites observa três slots globais, fila de onze chamadas,
  limite por alvo e liberação de recursos mesmo quando uma operação falha.
- Regressão adicional verifica round-robin/reutilização e exclusão de alvo em cooldown.
- Watchdogs de 10 s detectam travamento/serialização. Nenhuma assertion de sucesso
  exige resposta dentro de 30/40 ms; os testes têm timeout externo de 20 s.
- Nenhuma trava de quota, custos, HTTP, memória ou publicação foi removida.

## Repetição local

| Execução | Resultado observado |
| --- | --- |
| `npm run check` | 20 arquivos JavaScript verificados |
| `npm test` | 27 aprovados, 0 falhas, 0 ignorados |
| Regressão completa normal | 20 execuções consecutivas, todas 27/27 |
| Regressão com journal atrasado por fixture externa | 5 execuções, todas 27/27 |
| Total dessas repetições | 675 resultados de teste aprovados |
| Repetição da reprodução antiga após correção | PASS com o mesmo atraso de journal |

Os logs das execuções foram observados durante esta entrega; não são benchmarks
nem prova de compatibilidade de todos os providers/harnesses. As APIs nos testes
são fixtures; o teste HTTP usa servidor em loopback. Nenhuma API cloud foi chamada.

## Testes da força das assertions (mutações descartáveis)

Cada alteração abaixo foi aplicada somente a uma cópia temporária, nunca ao ZIP:

| Mutação | Resultado esperado e observado |
| --- | --- |
| Forçar limite global de uma chamada | O teste falha: workers não se sobrepõem |
| Desabilitar limite por alvo | O teste falha: excede os três slots esperados |
| Enviar todos os workers ao primeiro alvo | O teste falha: alvos não são distintos |

As três mutações foram detectadas. Isso verifica que a troca de temporização por
barreiras não fez os testes aceitarem execução serial nem limites desabilitados.

## Distribuição e publicação

O ZIP contém uma única pasta, sem `.env` privado, chaves, memória, `.git`, arquivos
antigos ou bundles duplicados. `PUBLIC_FILES.json` é regenerado com os hashes da
versão corrigida. `npm run check:release` verifica integridade, allowlist e padrões
heurísticos de secrets. O scanner não é uma garantia exaustiva de ausência de dados.

`PUBLICAR_WINDOWS.cmd` usa a pasta do próprio arquivo para chamar o publicador
existente com `--public`. Não requer digitar caminho e preserva o exit code. Ele
não substitui o gate de testes e não declara publicação antes da verificação remota.

O dry-run reexecuta sintaxe e regressão, sem GitHub/commits. A extração final deve
ser validada novamente com os mesmos comandos antes da entrega.

## Limitações desta validação

- Execução nativa Windows/Node 24 e do launcher `.cmd`: não realizada aqui.
- GitHub Actions Linux/Windows Node 22/24: configurado, não executado nesta sessão.
- Publicação remota: não realizada nesta sessão; o login local do usuário não
  autentica o terminal do assistente.
- Autenticação, saldo/quota e disponibilidade de contas de IA: não testados.
- Não foram instalados hosts Claude/Codex/Hermes nem alterado o artefato de aceitação.

`PUBLICACAO_REAL_NESTA_SESSAO=NAO_EXECUTADA`
`VALIDACAO_WINDOWS_NODE24=BLOCKED_BY_EXTERNAL_DEPENDENCY`

Fonte primária sobre temporizadores (contexto da correção, não substitui os testes):
https://nodejs.org/download/release/v24.1.0/docs/api/timers.html#settimeoutcallback-delay-args

## Reteste do pacote extraído nesta entrega

O ZIP foi extraído novamente em uma pasta nova cujo caminho contém espaços.
Nessa extração, `check:release` passou, e o publicador em `--dry-run` reexecutou
sintaxe e os 27 testes: 27 aprovados, zero falhas, zero ignorados. O dry-run terminou
com PASS para 62 arquivos públicos e não criou `.git` nem fez chamadas ao GitHub.

Também foi iniciado um processo Node real com `src/index.js --stdio`, a partir de
outra pasta: `initialize` retornou versão 2.2.4, `tools/list` retornou dez ferramentas
e o processo encerrou com código zero. Isso é um smoke local do transporte, não
instalação em um harness externo. O ZIP final foi regenerado após este registro e
os mesmos gates foram reexecutados no conteúdo extraído novamente.

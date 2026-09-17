# DZ23 Subagents Universal MCP

**Um projeto. Vários modelos. Uma memória compartilhada.**

Roteador MCP self-hosted para delegar tarefas de texto/código a modelos de IA,
coordenar especialistas em paralelo e guardar o estado explícito de cada missão.
**v4.3.0 · MIT · prévia de engenharia · Node.js 22+ · sem dependências npm de runtime.**

[English](README.en.md) · [Instalação](docs/INSTALL_ANY_HARNESS.md) · [Ferramentas](docs/TOOLS.md) · [Operação](docs/OPERATIONS.md) · [Arquitetura](docs/ARCHITECTURE.md) · [Provedores](docs/PROVIDER_ARCHITECTURE.md) · [Segurança](SECURITY.md) · [Validação](docs/VALIDATION.md)

## Para que serve

Claude pode registrar uma missão; Codex, Hermes ou outro cliente pode consultar
esse registro e continuar o trabalho. Para isso, ambos precisam usar **a mesma
instância de memória**, `project_id` e `mission_id`. A memória não vem automaticamente
da conversa privada do harness: ele deve enviar os fatos, decisões e checkpoints.

Se uma chamada ao provider falhar, o roteador classifica o erro, repete apenas falhas
temporárias e tenta o próximo alvo elegível com o estado persistido da missão. Não há
recuperação de pensamentos internos, tokens não recebidos ou efeitos externos não registrados.

Os subagentes são **chamadas independentes de modelo com papéis especializados**, não
processos com terminal, navegador ou acesso ao repositório. Eles produzem texto/código;
o harness aplica patches, executa testes e revisa os resultados sob as próprias permissões.

## O fluxo

```text
Claude / Codex / Hermes / cliente MCP
                 |
     stdio (local) ou HTTP autenticado
                 |
  validação de schema · escopos · rate limit · request_id
                 |
     roteador · orçamento · retry/failover · diversidade
          |                          |
   memória versionada           pool de modelos
   estado / journal / uso       architect / backend / frontend
   checkpoints / contexto       security / QA / devops / reviewer
          |                          |
          +------ resposta e handoff ------+
                       |
           o harness aplica e verifica
```

## O que existe hoje

| Área | Implementado nesta versão |
| --- | --- |
| MCP | 11 ferramentas da 4.0.0 + 16 novas; resources e prompts; revisões 2025-11-25 e 2025-06-18; schemas executados; erros JSON-RPC padronizados |
| Projeto e missões | Leitura segura de pastas permitidas e Git somente leitura; contexto anexado com máscara de segredos; missões assíncronas e em grafo; travas entre harnesses; log de auditoria |
| Roteamento | A MCP escolhe o modelo: faixa de custo primeiro e, dentro dela, o de melhor histórico para o tipo de tarefa; `routing_explain` e `cost_estimate` |
| Contas antes de API 4.3.0 | Faixa `account`: CLIs oficiais que você já logou (Claude Code, Codex, Gemini CLI e outras) e gateways de conta como o OmniRoute entram antes das APIs por token, com custo 0; `account_status` mostra o que está logado (opt-in por `DZ23_ACCOUNT_PROVIDERS`) |
| Operação 4.2.0 | Painel local somente leitura (`dashboard`); validação de patch em cópia isolada (`patch_validate`, desligada por padrão) |
| Transporte | stdio; HTTP JSON opcional (desligado por padrão), sem SSE/sessões/OAuth |
| Segurança HTTP | Token por variável ou arquivo, escopos por token, Host/Origin, rate limit e limites por processo |
| Delegação | OpenAI-compatible e Anthropic Messages; retry limitado; failover; cooldown por tipo de erro |
| Roteamento | `first`, `round_robin`, diversidade de provider/modelo, custo e latência, com diversidade observada |
| Consenso | Revisores em alvos distintos e síntese heurística rotulada como não verificada |
| Custos | Limites de tokens, chamadas e custo por chamada/missão/projeto/dia; preços só por tabela explícita |
| Providers | Inventário com flags de configuração, catálogo e inferência verificada; `verify_model` |
| Memória | Schema versionado, integridade, locks com dono, journal com sequência, contexto em camadas, reparo |
| Operação | Logs JSONL redigidos, métricas de processo, CLI (`doctor`, `providers`, `missions`, `memory repair`...) |

**Não entregue esta prévia como um SaaS multitenant ou como execução autônoma
completa de projetos.** Limites, contadores e orçamento são por processo. Veja
[Arquitetura](docs/ARCHITECTURE.md). O nome Universal descreve o objetivo de portabilidade;
não é certificação de compatibilidade com todos os hosts.

## Começar no computador

Clone o repositório e, na pasta do projeto:

```bash
node --version
npm run check
npm test
node scripts/install-harness.mjs all
node src/index.js doctor
```

Não é necessário `npm install`: o código usa apenas módulos nativos do Node.js 22+.
O campo `private: true` em `package.json` só impede publicação acidental no npm.

**Linux/macOS:** `bash scripts/install-local.sh` cria `.env` se ausente, preserva uma
configuração existente, executa a regressão e gera snippets.

**Windows (PowerShell):** `powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1`
realiza as mesmas etapas.

**Já tem 2.2.x ou 3.0.0 instalado?** Siga o [roteiro de atualização](docs/OPERATIONS.md#atualizando-de-22x300-para-400):
levantar o ambiente e o diretório de estado de cada harness, backup completo, pasta nova, revisão do
`.env`, `config validate`/`doctor` e substituição das entradas nos harnesses.

O repositório contém **somente `.env.example`**, com todos os provedores cadastrados (chave vazia) e
todas as variáveis suportadas: copie para `.env` e preencha só as chaves que tiver. O processo lê o
`.env` da instalação, não o do projeto do harness. Exemplo inicial com um servidor local que você
precisa iniciar:

```env
DZ23_ROTATION=custom:qwen3-coder
CUSTOM_BASE_URL=http://127.0.0.1:11434/v1
CUSTOM_MODEL=qwen3-coder
DZ23_ALLOW_PAID=false
```

Para nuvem: configure a chave em privado, rode `discover_models`, confirme com
`verify_model` (`confirm_billable: true`) e só então acrescente `provider:model` à rotação.

## Custos e orçamento

`free-first` apenas ordena categorias. `DZ23_ALLOW_PAID=false` bloqueia `paid` e `low-cost`,
inclusive alvos explícitos e, sem `DZ23_ROTATION`, modelos que não sejam o padrão do provider.
Também bloqueia `mixed` (OpenRouter, Gemini, Mistral, Together, Ollama cloud e outros que cobram
alguns modelos), exceto `provider:modelo` listados em `DZ23_FREE_MODELS` ou modelos `:free` do
OpenRouter: declare ali só modelos realmente gratuitos na sua conta. Modelos `:cloud` servidos por um
Ollama local também contam como `mixed`, e `free-tier` pode cobrar acima da cota grátis. `doctor`
mostra cada alvo como `eligible` ou `skipped(motivo)`.
Para limitar gasto, defina uma tabela de preços (`DZ23_PRICES_FILE`) e limites como
`DZ23_MAX_DAILY_COST_USD`, `DZ23_MAX_MISSION_COST_USD` ou `DZ23_MAX_MISSION_CALLS`; com limite de
custo, chamadas de custo desconhecido são negadas por padrão (`DZ23_COST_POLICY`).
O orçamento é verificado antes de cada chamada, inclusive retries, revisores e `health_check`.
`health_check` e `verify_model` exigem `confirm_billable: true`.
Preços nunca são inventados: sem tabela, o custo aparece como `unknown`. Configure também
limites de gasto no fornecedor. Detalhes em [Operação](docs/OPERATIONS.md#orçamento).

## Conectar o harness

`node scripts/install-harness.mjs all` gera **snippets para revisão**, sem editar
as configurações existentes de Claude/Codex:

```text
config/generated/claude_code_add_command.txt
config/generated/codex_config.snippet.toml
config/generated/claude_desktop_config.snippet.json
```

- **Claude Code**: rode o comando de `claude_code_add_command.txt`
  (`claude mcp add -s user dz23-subagents -- ...`) e confira com `claude mcp get dz23-subagents`.
- **Codex**: substitua a tabela `[mcp_servers.dz23-subagents]` de `~/.codex/config.toml` pelo snippet,
  que inclui `startup_timeout_sec = 30` e `tool_timeout_sec = 900`; nunca crie uma segunda tabela.
- Hermes e outros clientes precisam mapear `command`, `args` e transporte stdio ao próprio formato.

Ao atualizar, substitua a entrada existente em cada harness; não mantenha duas.
[Guia completo](docs/INSTALL_ANY_HARNESS.md) · [Prompt para o harness](HERMES_SELF_INSTALL_PROMPT.txt)

## CLI operacional

```bash
node src/index.js doctor --json
node src/index.js config validate
node src/index.js providers
node src/index.js missions list
node src/index.js memory repair
node src/index.js health --yes
```

Nenhum comando imprime segredos; `health` exige `--yes` porque pode cobrar e
`memory repair --apply` exige `--yes`. Códigos de saída: 0, 1, 2 e 78.

## Exemplo de uso pela IA

> Use o MCP dz23-subagents. Registre o projeto `minha-app` e a missão `m-001`.
> Consulte o inventário sem expor segredos. Delegue análises de backend, frontend
> e QA com `swarm_run`, estratégia `provider_diversity`, limite de três agentes.
> Revise as propostas antes de editar arquivos. Execute os testes localmente.
> Salve decisões, critérios e o próximo passo com `memory_checkpoint`.

Outro harness conecta à mesma memória, chama `mission_status` com os mesmos IDs,
confere Git/arquivos/testes por conta própria e continua.

## Testes e publicação

```bash
npm run check
npm test
npm run check:release
npm run check:public
```

CI roda lint, testes em Linux/Windows com Node 22/24, contratos MCP por fixtures, relatório de
cobertura e auditoria dos arquivos públicos. Os testes usam apenas fixtures locais, sem credenciais.
[Publicar no GitHub](docs/PUBLISH_GITHUB.md) descreve a primeira publicação e as atualizações.

## Contribuir

Leia [CONTRIBUTING.md](CONTRIBUTING.md), [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md),
[SECURITY.md](SECURITY.md) e [ROADMAP](docs/ROADMAP.md). Relatórios devem separar
fixtures, testes locais e validação real de provedores. Sem benchmarks comparativos,
não alegamos que o produto seja mais rápido ou melhor que outros roteadores.

## Licença

MIT, com o aviso de copyright DZ23 original preservado em [LICENSE](LICENSE).
As marcas dos clientes e provedores pertencem aos respectivos titulares; não há
alegação de afiliação ou endosso. A licença do código não fornece créditos de API.

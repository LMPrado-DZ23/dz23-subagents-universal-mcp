# DZ23 Subagents Universal MCP

**Um projeto. Vários modelos. Uma memória compartilhada.**

Roteador MCP self-hosted para delegar tarefas de texto/código a modelos de IA,
coordenar especialistas em paralelo e guardar o estado explícito de cada missão.
**v2.2.4 · MIT · prévia de engenharia · Node.js 22+ · sem dependências npm de runtime.**

[English](README.en.md) · [Instalação](docs/INSTALL_ANY_HARNESS.md) · [Ferramentas](docs/TOOLS.md) · [Provedores](docs/PROVIDER_ARCHITECTURE.md) · [Segurança](SECURITY.md) · [Validação](docs/VALIDATION.md)

## Para que serve

Claude pode registrar uma missão; Codex, Hermes ou outro cliente pode consultar
esse registro e continuar o trabalho. Para isso, ambos precisam usar **a mesma
instância de memória**, `project_id` e `mission_id`. A memória não vem automaticamente
da conversa privada do harness: ele deve enviar os fatos, decisões e checkpoints.

Se uma chamada ao provider falhar, o roteador registra o erro e tenta o próximo
alvo elegível, incluindo o estado persistido da missão. Não há recuperação dos
pensamentos internos, tokens não recebidos ou efeitos externos que nunca foram registrados.

Os subagentes desta versão são **chamadas independentes de modelo com papéis
especializados**, não processos com terminal, navegador ou acesso automático ao
repositório. Eles produzem texto/código; o harness aplica patches, executa testes e
revisa os resultados sob as próprias permissões. O projeto não contorna limites,
salvaguardas ou políticas de fornecedores.

## O fluxo

```text
Claude / Codex / Hermes / cliente MCP
                 |
        stdio (local) ou HTTP
                 |
     DZ23 Router + limite de chamadas
          |                  |
   memória por missão    pool de modelos
   estado / journal      architect / frontend / backend
   checkpoints           security / QA / devops / reviewer
          |                  |
          +---- resposta e handoff ----+
                       |
           o harness aplica e verifica
```

## O que existe hoje

| Recurso | Escopo implementado |
| --- | --- |
| Delegação e failover | OpenAI-compatible e Anthropic Messages nativa; saída textual |
| Memória | JSON, journal e checkpoints no filesystem; locks por projeto |
| Paralelismo | Limites de chamadas globais e por provider:model, por processo |
| Papéis | Architect, Backend, Frontend, Security, QA, DevOps, Reviewer e nomes customizados |
| Inventário | Configuração e origem da credencial, sem devolver o valor da chave |
| Model discovery | Consulta ao catálogo exposto pelo adapter; não prova acesso a inferência |
| Saúde | Uma pequena geração real, quando o operador chama `health_check` |
| MCP | Descoberta/chamada de ferramentas via stdio; HTTP JSON sem SSE |
| Segredos | Ambiente e arquivos `*_FILE`; sem Vault, OAuth ou multitenancy implementados |

**Não entregue esta prévia como um SaaS multitenant ou como execução autônoma
completa de projetos.** Veja os limites em [Arquitetura](docs/ARCHITECTURE.md).
O nome Universal descreve o objetivo de portabilidade; não é certificação de
compatibilidade com todos os hosts ou versões do protocolo.

## Começar no computador

Extraia o pacote ou, depois da publicação, clone o repositório. Na pasta do projeto:

```bash
node --version
npm run check
npm test
node scripts/install-harness.mjs all
```

Use Node.js 22 ou superior mantido pelo projeto Node.js. Não é necessário
`npm install`: o código usa módulos nativos. O campo `private: true` em `package.json`
apenas impede publicação acidental no npm; não torna o código proprietário.

**Linux/macOS:** `bash scripts/install-local.sh` cria `.env` se ausente, preserva uma
configuração existente, executa a regressão e gera snippets.

**Windows (PowerShell):** `./scripts/install-windows.ps1` realiza as mesmas etapas.
Não desabilite políticas de segurança globais para executar o script.

O repositório público contém **somente `.env.example`**. Os instaladores criam o `.env`
privado no computador. Para configuração manual, copie o exemplo apenas quando
não houver `.env`. O processo lê o `.env` da instalação, não o do projeto do harness.

Exemplo inicial, limitado a um servidor local que você precisa instalar/iniciar:

```env
DZ23_ROTATION=custom:qwen3-coder
CUSTOM_BASE_URL=http://127.0.0.1:11434/v1
CUSTOM_MODEL=qwen3-coder
DZ23_ALLOW_PAID=false
```

Troque `qwen3-coder` pelo ID realmente disponível no seu servidor. Nenhum modelo
é baixado ou iniciado por este pacote. Para cloud, configure a chave em privado,
consulte `discover_models`, escolha um modelo habilitado e só então acrescente
`provider:model` à rotação. O ID do modelo pode conter dois-pontos.

**Atenção a custos:** `free-first` ordena categorias; não consulta a fatura nem
impõe um teto financeiro. `DZ23_ALLOW_PAID=false` bloqueia categorias `paid` e
`low-cost`, inclusive alvos explícitos. Categorias `mixed` e `free-tier` podem
cobrar após limites da conta. Para evitar uso cloud, mantenha a rotação apenas
nos seus servidores locais. Configure limites de gasto no fornecedor.
`health_check`, `delegate`, `consensus` e `swarm_run` podem consumir quota/créditos.

## Conectar o harness

`node scripts/install-harness.mjs all` gera **snippets para revisão**, sem editar
as configurações existentes de Claude/Codex:

```text
config/generated/claude_desktop_config.snippet.json
config/generated/codex_config.snippet.toml
```

Copie somente a entrada `dz23-subagents` para o arquivo do cliente correspondente.
O gerador usa os caminhos reais do Node e da instalação. Hermes e outros clientes
precisam mapear `command`, `args` e transporte stdio ao próprio formato.

[Guia completo](docs/INSTALL_ANY_HARNESS.md) · [Prompt para o harness](HERMES_SELF_INSTALL_PROMPT.txt)

## Exemplo de uso pela IA

Peça ao harness:

> Use o MCP dz23-subagents. Registre o projeto `minha-app` e a missão `m-001`.
> Consulte o inventário sem expor segredos. Delegue análises de backend, frontend
> e QA com `swarm_run`, limite de três agentes. Revise as propostas antes de editar
> arquivos. Execute os testes localmente. Salve o próximo passo com `memory_checkpoint`.

Outro harness deve conectar à mesma memória, chamar `mission_status` com os mesmos
IDs, conferir Git/arquivos/testes por conta própria e continuar. O roteador não
abre automaticamente Codex quando a assinatura do Claude chega ao limite.

## Testes e publicação

No Windows, extraia em uma pasta nova e abra **`PUBLICAR_WINDOWS.cmd`** para
publicar usando GitHub CLI já autenticado. Ele encontra a pasta correta sem
digitar caminhos e mantém todas as verificações do publicador.

```bash
npm run check
npm test
npm run check:release
node scripts/publish-github.mjs --public --dry-run
```

O dry-run não chama GitHub nem cria commits. A publicação real exige Git, GitHub CLI,
autenticação local e o comando sem `--dry-run`.
[Publicar no GitHub](docs/PUBLISH_GITHUB.md) explica permissões, verificação e recuperação.
Não se presume que o repositório já esteja publicado apenas porque este README existe.

## Contribuir

Leia [CONTRIBUTING.md](CONTRIBUTING.md), [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md),
[SECURITY.md](SECURITY.md) e [ROADMAP](docs/ROADMAP.md). Relatórios devem separar
mocks, testes locais e validação real de provedores. Sem benchmarks comparativos,
não alegamos que o produto seja mais rápido ou melhor que outros roteadores.

## Licença

MIT, com o aviso de copyright DZ23 original preservado em [LICENSE](LICENSE).
As marcas dos clientes e provedores pertencem aos respectivos titulares; não há
alegação de afiliação ou endosso. A licença do código não fornece créditos de API.

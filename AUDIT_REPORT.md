# Relatório de auditoria — DZ23 Subagents Universal MCP 4.1.0

## Escopo

Esta entrega continua o repositório oficial a partir da base v4.0.0. O objetivo foi incorporar a fundação de Tool Gateway, contexto de projeto seguro, coordenação entre harnesses, jobs assíncronos, compatibilidade MCP de resources/prompts, economia de chamadas e privacidade, sem copiar código de Dify, SuperAGI ou SDKs oficiais e sem adicionar dependências npm de runtime.

## Mudanças verificáveis

A política de custo permanece centralizada no roteador e não foi duplicada nas novas ferramentas. `TOOL_POLICIES` agora é um registro declarativo com escopos, classe de custo, billable, timeout, abort, budget, redaction, audit event e enabled-by. As operações de workspace passam por roots permitidas, realpath, bloqueio de segredos, limites e Git readonly.

Contexto anexado recebe nonce e marcadores explícitos de dado não confiável. `privacy=auto` mascara padrões de chaves e PII brasileira, e arquivos com padrões de prompt injection recebem aviso. `output_schema`, `detail`, `max_response_chars`, `idempotency_key` e cache opt-in possuem efeitos reais no handler.

Jobs de missão retornam `job_id`, persistem `loop_state`, aceitam cancelamento, pausa e retomada, respeitam deadline e detectam estagnação. A missão não é declarada concluída somente porque o loop terminou: é necessário haver evidência de testes/checkpoint do harness. Leases evitam execução concorrente por harnesses diferentes, e `handoff_export` gera um briefing Markdown.

A implementação publica `resources/list`, `resources/read`, `prompts/list` e `prompts/get`. Tasks MCP oficiais ainda não são anunciadas, conforme o roadmap do anexo, até haver fixtures e validação específica das revisões suportadas. O sandbox de patch permanece reservado ao PR 8/versão 5.0 e não está exposto.

## Evidência executada

Os comandos abaixo foram executados no checkout de trabalho:

```text
node --check src/mcp.js
node --check src/mission-manager.js
node --check src/coordination.js
node --check src/audit-log.js
npm run check
npm test
npm run check:release
npm run check:public
```

Resultado observado: `npm test` terminou com **218 aprovados, 0 falhas, 1 skipped**. O skip é específico de filesystem case-insensitive. `check:release` terminou com `RELEASE_CHECK=PASS`, versão `4.1.0`, sem padrões de segredo. `check:public` terminou com `PUBLIC_FILES_AUDIT=PASS` em checkout Git temporário, com 128 arquivos rastreados e 127 listados no manifesto, além do próprio manifesto.

Os testes adicionais cobrem roots, traversal, symlink, arquivos protegidos, Git readonly, contexto nonce-marked, redaction de PII/segredos, prompt injection, leases, expiração lógica, release por token, audit log com hash encadeado, resources e prompts MCP.

## Reprodução

```bash
unzip dz23-subagents-universal-mcp-4.1.0.zip
cd dz23-subagents-universal-mcp-4.1.0
npm run check
npm test
npm run check:release
# check:public requer checkout Git; a CI executa git ls-files antes do comando
```

## Riscos e observações

O cache e o audit log são locais ao processo/diretório de estado. O audit log registra metadados redigidos; não é uma garantia criptográfica de armazenamento imutável contra um operador que controla o diretório. A redação de PII é heurística e não substitui classificação jurídica ou DLP dedicada.

`mission_resume` retoma usando diagnóstico persistido e não é ainda um executor de DAG completo. A conclusão depende de evidência registrada, mas a qualidade dessa evidência continua sendo responsabilidade do harness. O marcador de prompt injection é um detector de alerta, não uma prova de ataque.

## Não verificado

Não foram verificados nesta execução: Windows Node 22/24 em CI; macOS; MCP Inspector; Tasks MCP oficiais; providers reais; Ollama, LM Studio e vLLM; OmniRoute; quotas reais via headers; Windows Credential Manager; keychain/libsecret; webhook ntfy/Telegram/HTTP; OTLP; upgrade dry-run com rollback; fake-provider de caos; fuzzing de schemas; SBOM/attestation de GitHub; painel HTTP readonly; RAG lexical persistido; sandbox de patch da versão 5.0.

## Referências de projeto

As ideias de workflow/RAG/LLMOps foram comparadas ao [Dify](https://github.com/langgenius/dify), as ideias de toolkits/memória/telemetria ao [SuperAGI](https://github.com/TransformerOptimus/SuperAGI), e o contrato de integração a [Model Context Protocol](https://github.com/modelcontextprotocol). Nenhum código desses projetos foi copiado.

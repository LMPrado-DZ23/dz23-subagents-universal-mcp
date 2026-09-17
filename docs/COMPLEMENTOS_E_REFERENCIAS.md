# Complementos e referências para o DZ23 Subagents Universal MCP 4.1

## Conclusão

Os três repositórios são úteis, mas não devem ser tratados como um único bloco para copiar. O DZ23 é um **control plane MCP self-hosted, seguro e zero-dependency**; Dify e SuperAGI são plataformas/frameworks maiores; o Model Context Protocol é a referência normativa do contrato de integração.

## Matriz de valor

| Referência | O que agrega | Como incorporar | O que não copiar diretamente |
| --- | --- | --- | --- |
| [Dify](https://github.com/langgenius/dify) | Workflows visuais, RAG, catálogo de providers, sandbox de agentes, LLMOps, APIs e observabilidade | Modelar missões como DAG/estado, adicionar adapters de RAG, métricas por provider, traces e painel readonly | Runtime Python/Node completo, banco, filas, Docker e licença Dify dentro do núcleo zero-dependency |
| [SuperAGI](https://github.com/TransformerOptimus/SuperAGI) | Toolkits, marketplace conceitual, memória de agentes, console de ações, workflows, telemetria e uso concorrente | Definir Tool Gateway por escopos, catálogo de adapters, leases de missão, memória por agente e métricas de execução | Arquitetura inteira baseada em serviços, Redis/Celery, GUI e dependências; manter somente padrões e ideias compatíveis com MIT |
| [Model Context Protocol](https://github.com/modelcontextprotocol) | Contrato oficial, SDKs, Inspector, tasks, resources, prompts, authorization e compatibilidade com clientes | Implementar `resources/list/read`, `prompts/list/get`, tasks longas conforme a revisão suportada e validar com Inspector | Não inventar extensões incompatíveis nem declarar tasks suportadas sem testes do protocolo |

## Prioridade recomendada

### Prioridade 1 — MCP oficial

A compatibilidade protocolar vem antes de qualquer painel ou workflow. A v4.1 deve expor missões e relatórios como resources, templates de auditoria/correção como prompts e jobs longos como tasks quando a versão negociada suportar. A implementação deve continuar aceitando os 11 tools da v4.0.0.

### Prioridade 2 — padrões do SuperAGI

A ideia mais útil é o **Tool Gateway**: cada capacidade é um adapter com schema fechado, escopo, prazo, cancelamento, orçamento, redaction, auditoria e testes negativos. O catálogo de toolkits deve ser declarativo, mas o runtime só carrega adapters explicitamente habilitados. A memória de agentes e leases evitam dois harnesses executarem a mesma missão ao mesmo tempo.

### Prioridade 3 — padrões do Dify

Dify agrega duas ideias importantes: o workflow como grafo verificável e a separação entre execução, provider/model management e observabilidade. O DZ23 deve adotar um DAG leve em JSON persistido na memória, sem trazer uma plataforma inteira. Cada nó precisa declarar entrada, saída, dependências, timeout, retry, custo e evidência.

RAG entra como adapter posterior: ingestão e busca devem respeitar `DZ23_WORKSPACE_ROOTS`, redaction, privacy e limites. A busca não pode transformar texto encontrado em instrução autorizada.

## Decisões de arquitetura

1. **O orquestrador externo continua decidindo a estratégia.** A MCP executa, persiste e verifica; ela não deve assumir que uma UI visual ou um agente autônomo possui autorização implícita.
2. **Free-first permanece central.** Catálogos de providers podem ser inspirados por Dify, mas a seleção é sempre a função de política do DZ23: `effectiveTier`, `DZ23_FREE_MODELS`, rotação, orçamento e privacy.
3. **Zero dependências npm permanece regra.** SDK oficial só será usado como referência de contrato ou incorporado quando a dependência for explicitamente aceita em uma etapa futura; não será introduzido silenciosamente.
4. **Código externo não é copiado sem revisão de licença.** Dify informa uma licença própria com condições adicionais; SuperAGI informa MIT; MCP oficial tem seus próprios repositórios e licenças. Esta entrega usa ideias e links, não copia código desses projetos.
5. **Ferramentas perigosas são adapters isolados.** Terminal, escrita, Git mutável, browser, deploy e GitHub devem ficar atrás de permissões, sandbox, aprovação e rollback.

## Backlog derivado

| Item | Origem | Critério de aceite |
| --- | --- | --- |
| Resources de missão/relatório | MCP oficial | `resources/list` e `resources/read` sem vazar segredos e com testes de autorização |
| Prompts de auditoria/correção | MCP oficial | `prompts/list/get` com argumentos validados e contexto marcado como não confiável |
| Tasks para jobs longos | MCP oficial | cliente capaz de consultar, cancelar e receber estado sem bloquear o request |
| Tool Gateway declarativo | SuperAGI | adapter com escopo, quota, deadline, abort, redaction e audit event |
| Leases entre harnesses | SuperAGI | `mission_claim/release`, expiração e resposta `mission_busy` |
| DAG de missão | Dify | dependências, retomada, checkpoint, diagnóstico e evidência por nó |
| RAG seguro | Dify | busca limitada às roots autorizadas, PII masking e injection warning |
| LLMOps local | Dify/SuperAGI | métricas de latência, sucesso, custo, quota e regressão sem serviço externo obrigatório |
| Painel readonly | ambos | HTTP autenticado, somente leitura, sem novos privilégios |

## Fontes consultadas

- Dify: plataforma de workflows agentic, RAG, providers, sandbox, LLMOps e APIs; o repositório informa licença Dify Open Source License.
- SuperAGI: framework de agentes autônomos com toolkits, memória, workflows, telemetria e concorrência; o repositório informa licença MIT.
- Model Context Protocol: organização oficial com SDKs, Inspector, registry, `ext-tasks` e `ext-apps`.

Esta análise é uma referência de arquitetura. Ela não afirma que qualquer recurso listado como backlog já foi implementado.

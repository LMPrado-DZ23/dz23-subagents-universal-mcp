# Publicar o projeto no GitHub

## Estado desta entrega

O pacote é preparado para publicação; não é prova de um repositório criado.
O destino proposto é **LMPrado-DZ23/dz23-subagents-universal-mcp**, novo e público.
A licença MIT já existia no ZIP de origem e foi preservada.

## Autenticação segura no seu computador

Requisitos: Node.js 22+, Git e GitHub CLI (`gh`). Use os instaladores oficiais.
Autentique-se pelo fluxo de navegador no próprio computador, sem enviar token ao chat:

```bash
gh auth login --hostname github.com --git-protocol https --web --scopes workflow
gh auth status --hostname github.com
```

A autorização precisa permitir criar o repositório, gravar conteúdo e publicar
workflows. A conexão de leitura de um assistente não transfere suas credenciais
para um terminal. Não cadastrar chaves dos providers no GitHub para estes testes:
a CI usa apenas fixtures locais, sem inferência paga.

## Publicar a partir de uma extração nova

**Windows:** abra `PUBLICAR_WINDOWS.cmd` na pasta extraída. Ele usa a pasta do próprio
arquivo, não a pasta atual do PowerShell, executa o mesmo publicador abaixo e mantém
a janela aberta para leitura do resultado. Não executar de dentro do visualizador
ZIP. O launcher não desabilita verificações, não autentica silenciosamente outra
conta e não altera outros projetos. Sua execução nativa no Windows precisa ser
validada nesse sistema; o relatório local desta entrega não a declara concluída.

**Falha de teste na v2.2.3:** utilize o pacote v2.2.4 extraído em pasta nova.
O erro `expected real parallelism` foi reproduzido com journal lento; a correção
usa barreiras para observar chamadas simultâneas, não uma espera maior para
"passar". A distribuição inicial entre alvos também foi corrigida. Não pule
`npm test`, não remova assertions e não force a publicação da versão anterior.


Na pasta que contém `package.json`:

```bash
node scripts/publish-github.mjs --public --dry-run
node scripts/publish-github.mjs --public
```

O primeiro comando valida sem chamar o GitHub. O segundo valida novamente, verifica
conta/nome, cria Git local apenas se não houver `.git`, prepara somente os arquivos
auditados, cria repositório público novo, faz push e compara o commit remoto com o
local. Ele imprime `PUBLISHED=TRUE` somente depois dessas verificações.

O script não altera configurações Git globais, não usa force-push, não converte
repositórios privados em públicos, não cria assinatura paga e não publica no npm.
O commit usa o endereço noreply da conta autenticada. Não contém o `.env`, memória,
logs, backups, configs geradas ou ZIPs anteriores.

Se o destino já existir, o script para sem alterar nada. Para um fork em outra
conta pessoal: `--owner=SUA_CONTA --name=SEU_REPOSITORIO`. Organizações não são
provisionadas por este script; exigem um fluxo de autorização próprio.

## Falhas parciais

Se o push falhar depois da criação remota, pode existir um repositório público vazio
ou parcialmente publicado. Não apagar para tentar de novo. Confira conta/permissões,
`git status`, `git remote -v` e o conteúdo remoto; um operador autorizado deve concluir
o push normal após comparar os commits. O script de primeira publicação recusa `.git`
existente de propósito. Um erro de workflow requer autorização adequada; nunca
remover a CI para esconder a falha.

## Depois do push

Confira arquivos/visibilidade e GitHub Actions. A matriz configurada cobre
Linux/Windows, Node 22/24; ela precisa executar no GitHub para ser considerada aprovada.
Habilite private vulnerability reporting e proteção de branch com revisão/checks
conforme as funções disponibilizadas pela sua conta; não presumimos ativação automática.

Para futuros commits, trabalhe por branch/PR, preserve testes e atualize o manifesto
com `node scripts/update-manifest.mjs` após revisar os arquivos públicos. A atualização
dos hashes não substitui revisão humana. Revise mudanças de LICENSE separadamente.

## Atualizações de um repositório já publicado

`scripts/publish-github.mjs` serve apenas para a primeira publicação e recusa `.git`
existente. Para versões seguintes:

1. Trabalhe em um branch, rode `npm run check`, `npm test`, regenere o manifesto com
   `node scripts/update-manifest.mjs`, depois `npm run check:release` e `npm run check:public`.
2. Envie o branch e aguarde o GitHub Actions concluir com sucesso.
3. Integre em `main` sem force-push, crie a tag `vX.Y.Z` no commit verificado e publique a
   release apontando para essa tag.
4. Confirme remotamente o commit da tag, a visibilidade e o resultado do CI antes de anunciar.

Fontes oficiais consultadas em 2026-09-12:
- https://cli.github.com/manual/gh_auth_login
- https://cli.github.com/manual/gh_repo_create
- https://docs.github.com/en/migrations/importing-source-code/using-the-command-line-to-import-source-code/adding-locally-hosted-code-to-github
- https://docs.github.com/articles/licensing-a-repository

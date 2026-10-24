# Sprint A-F — Fechamento técnico do roteamento da Central

**Projeto:** CDS Sistemas — Pastelaria  
**Escopo:** investigação das sete falhas relatadas na Sprint A, regressão do roteamento e validação visual disponível  
**Adendo Sprint A-F1:** a fixture NSU foi corrigida; os seis cenários Central antes bloqueados passaram individualmente e a suíte completa passou com **18/18**, incluindo uma regressão fail-closed. A validação visual continua pendente por HTTP 403 e não foi retomada nesta etapa.

**Decisão recomendada:** considerar a correção isolada A-F1 aprovada em testes. O fechamento global da Sprint A permanece sem validação visual, que depende de ambiente autorizado.

## 1. Resumo executivo

As sete falhas foram reproduzidas e classificadas individualmente:

- A falha de Central → Compras era uma asserção obsoleta, acoplada à implementação interna. A função de confirmação delega ao helper que efetivamente chama `showNotification`; a asserção foi atualizada para cobrir a delegação, os caminhos de sucesso e de sugestão inválida. O teste passou: **5 ok, 0 falhas**.
- As outras seis falhas pertenciam ao teste dos serviços da Central. A causa confirmada foi a ausência de `central_entradas_nsu` na fixture em memória; a tabela e controles NSU fictícios foram adicionados na Sprint A-F1. Os seis cenários passaram individualmente e a suíte completa passou com **18/18**.
- Não foi comprovado defeito de roteamento da Sprint A nesses seis cenários. Nenhum serviço da Central foi alterado.
- A interface compartilhada carrega a navegação, mas suas chamadas do dashboard retornam **403 Forbidden**. Não havia ambiente autorizado com dados fictícios para executar os fluxos visuais. A validação visual fica pendente.

O bloqueio da fixture Central foi resolvido na Sprint A-F1, detalhada no [relatório A-F1](./central-entradas-roteamento-sprint-af1-relatorio.md). A validação visual não foi iniciada nesta etapa, conforme seu escopo. Não iniciar a Sprint B.

## 2. Investigação individual das sete falhas — diagnóstico inicial A-F

| # | Teste/cenário | Evidência da reprodução | Causa e classificação | Ação |
|---|---|---|---|---|
| 1 | `tests/compras/rc4312-central-fluxos.test.js` — `confirmarAssociacaoMiip não retorna silenciosamente` | A asserção antiga procurava a mensagem de sucesso dentro de `confirmarAssociacaoMiip`. O código em `frontend/erp/js/compras.js` chama `confirmarAssociacaoMiipComProduto`; o helper exibe `showNotification(opcoes.mensagemSucesso || 'Associação confirmada.', 'success')`. O ramo sem sugestão válida também exibe notificação de aviso. | **Teste desatualizado/acoplado à implementação**, não defeito funcional comprovado. | Alterada somente a asserção para validar a delegação, a notificação de sucesso no helper e a notificação de aviso. Reexecução: **5 ok, 0 falhas**. |
| 2 | `tests/central-entradas/central-entradas-03-xml.test.js` — cStat 137 no motor | Na execução inicial: `ultimoRetorno` obtido `null`, esperado `'137'`, asserção na linha 448. O log registrou `SQLITE_ERROR: no such table: central_entradas_nsu` e `cooldown_nsu_fail_closed`. | **Fixture/configuração inadequada**, confirmada: a conexão `:memory:` não tinha tabela/controle NSU; a proteção fail-closed impediu a consulta simulada. | Na A-F1, o schema e os controles fictícios foram adicionados à fixture. O cenário foi executado isoladamente e passou: **1/1**. |
| 3 | Mesmo arquivo — cStat 656 no motor | Na execução inicial: chamadas observadas ao Gate `[]`, esperadas `['656']`, asserção na linha 473; o fluxo parou antes do transporte por NSU ausente. | **Fixture/configuração inadequada**, mesma causa do item 2; não era defeito no tratamento de 656. | Na A-F1, executado isoladamente com a fixture corrigida: **1/1**. A asserção de cooldown/Gate foi mantida. |
| 4 | Mesmo arquivo — rejeição SEFAZ no motor | Na execução inicial: `rel.falhas` obtido `0`, esperado `1`, asserção na linha 515; a resposta simulada de rejeição não foi consultada. | **Fixture/configuração inadequada**, mesma causa do item 2; o caminho da rejeição não era alcançado. | Na A-F1, executado isoladamente com a fixture corrigida: **1/1**. |
| 5 | Mesmo arquivo — isolamento de três empresas no motor | Na execução inicial: `rel.recuperados` obtido `0`, esperado `3`, asserção na linha 578; consultas foram barradas por NSU ausente. | **Fixture/configuração inadequada**, mesma causa do item 2; não indicava vínculo cruzado entre empresas. | Na A-F1, executado isoladamente com controles NSU distintos por CNPJ/ambiente: **1/1**. |
| 6 | Mesmo arquivo — lock de ciclos simultâneos | Na execução inicial: chamadas `consChNFe` obtidas `0`, esperadas `1`, asserção na linha 601; a consulta não iniciou. | **Fixture/configuração inadequada**, mesma causa do item 2; o lock não era exercitado. | Na A-F1, executado isoladamente com a fixture corrigida: **1/1**. |
| 7 | Mesmo arquivo — documento antigo após 596 | Na execução inicial: `rel.recuperados` obtido `0`, esperado `1`, asserção na linha 621; o log registrou erro NSU antes da reconsulta. | **Fixture/configuração inadequada**, mesma causa do item 2; não indicava defeito de recuperação ou duplicação. | Na A-F1, executado isoladamente com a fixture corrigida: **1/1**. |

### Evidência da causa comum das falhas 2–7

Na execução inicial A-F, `MotorRecuperacaoXmlService` consultava `CentralNsuService.buscarPorCnpjAmbiente` antes de `consChNFe` e bloqueava a recuperação quando a leitura falhava. `CentralNsuRepository` executa `SELECT` em `central_entradas_nsu`; o schema é criado em `backend/database.js`. O harness substituía `backend/database` por uma conexão SQLite em memória sem criar essa tabela.

A relação causal foi testada: cada um dos seis cenários falhou isoladamente no harness original e passou isoladamente em execução diagnóstica que forneceu ao motor uma dependência NSU em memória (`buscarPorCnpjAmbiente` com estado de teste e `avaliarCooldown` inativo). Essa execução diagnóstica não modificou arquivos e não foi contabilizada como aprovação da suíte original.

O código de verificação de cooldown NSU no motor e outras alterações da Central já estavam no diff local antes desta Sprint A-F. A proteção fail-closed não foi removida nem contornada. A lacuna da fixture foi corrigida na A-F1, sem alteração dos serviços.

## 3. Arquivos alterados nesta Sprint A-F

| Arquivo | Alteração |
|---|---|
| `tests/compras/rc4312-central-fluxos.test.js` | Substituída a busca textual por asserções da cadeia observável de confirmação: wrapper delega ao helper, helper notifica sucesso e wrapper notifica sugestão inválida. |
| `docs/vendas/central-entradas-roteamento-sprint-af-fechamento-tecnico.md` | Este relatório de fechamento, com evidências, resultados, classificação e pendências. |

Nenhum código operacional da Central, MIIP/MIP, roteamento, schema, banco ou fiscal foi alterado nesta etapa.

## 4. Testes e resultados finais

### Suítes executadas

| Comando | Resultado |
|---|---|
| `node tests/shared/nfe/nfe-parser.test.js` | **6 passaram, 0 falharam.** |
| `node tests/compras/classificacao-itens-nfe-compra.test.js` | **15 passaram, 0 falharam.** Teste utilizou banco temporário. |
| `node tests/produto-identidade/mip-sprint07-compras-xml-central.test.js` com `DB_DIR` temporário | **13 passaram, 0 falharam.** |
| `node tests/miip/miip-importacao-xml.test.js` | **12 passaram, 0 falharam.** |
| `node tests/miip/decision-engine.test.js` | **69 passaram, 0 falharam.** |
| `node tests/miip/motor-associacao-fornecedor.test.js` | **17 passaram, 0 falharam.** |
| `node tests/compras/rc4312-central-fluxos.test.js` | **5 passaram, 0 falharam.** |
| `node tests/central-entradas/central-entradas-03-xml.test.js` | Inicial A-F: 11 passaram, 6 falharam. Após A-F1: **18 passaram, 0 falharam**, incluindo a regressão fail-closed. |
| Seis cenários Central executados individualmente após A-F1 | **1 passou, 0 falhou em cada cenário**, um cenário por processo. |
| `node --check` nos arquivos JavaScript alterados/verificados | **Passou.** |
| `git diff --check` | **Passou.** Git emitiu somente o aviso de normalização CRLF/LF em `backend/server.js`, arquivo preexistente e não alterado nesta etapa. |

Resultado atualizado das oito suítes de regressão listadas: **155 aprovações e 0 falhas** na execução mais recente de cada suíte. O resultado inicial A-F foi **148 aprovações e 6 falhas**; as seis falhas Central foram resolvidas pela fixture A-F1. A correção anterior da asserção Central → Compras elevou o registro intermediário a 148/6 antes da correção desta fixture.

### Ambiente visual

A página compartilhada `http://127.0.0.1:3011/erp/` exibiu a navegação, mas registrou respostas HTTP **403 Forbidden** em chamadas de recursos/dashboard, inclusive erro de carregamento do dashboard. Não havia ambiente de teste autorizado/dados fictícios acessíveis para concluir a revisão dos candidatos, resumo do lote e persistência visual.

Não foram contornadas permissões, licença ou autenticação. Os cenários visuais 1–7 da solicitação ficam **bloqueados/não executados**; os testes automatizados de código não são apresentados como substitutos da validação visual.

## 5. Comparação e estado das regressões de roteamento

Os testes pertinentes da Sprint A executados nesta etapa passaram: parser NF-e, compra mista/classificação e persistência, identidade MIP em XML Central, MIIP, associação por fornecedor e fluxo Central → Compras. O caso de conflito MIIP × MIP também está coberto pelo teste de identidade e sua atualização de resumo.

As seis falhas restantes não demonstraram seleção incorreta de produto, perda de identidade, reclassificação, mistura de empresas ou duplicidade. Os cenários foram impedidos pela dependência NSU da Central antes de exercer suas afirmações operacionais. A validação visual, contudo, continua pendente.

## 6. Preservação do workspace e proteções

- Antes da edição foi inspecionado o estado do workspace, incluindo alterações staged, unstaged e arquivos não rastreados. Já havia alterações locais em vários módulos da Central, banco de dados, frontend e testes. Foram preservadas.
- Nesta Sprint A-F, somente a asserção do teste `rc4312-central-fluxos.test.js` foi alterada; nenhum outro diff preexistente foi revertido, reorganizado ou sobrescrito.
- Todos os testes com banco foram executados em banco temporário ou em memória. **O banco oficial `C:\ProgramData\MercantilFiscal\dados` não foi acessado, aberto, migrado nem alterado.**
- Os transportes SEFAZ usados pelos testes são simulados. **Nenhuma consulta, manifestação, sincronização ou operação real foi enviada à SEFAZ.**
- Não foram executados commit, push, merge, reset, rebase ou rollback destrutivo.

## 7. Pendências e recomendação — estado antes da Sprint A-F1

1. A correção do harness e a execução dos seis cenários foram concluídas na Sprint A-F1.
2. Disponibilizar ambiente visual autorizado e dados fictícios para validar ambiguidades, candidatos, contagem, confirmação explícita e persistência.
3. Não iniciar a Sprint B até a revisão do Product Owner e do Tech Lead.

**Conclusão histórica da Sprint A-F:** não foi encontrado defeito funcional relacionado ao roteamento da Sprint A entre as sete falhas investigadas. A asserção obsoleta foi corrigida; à época, seis falhas da fixture Central ainda permaneciam e a validação visual estava bloqueada.

## 8. Adendo — resultado da Sprint A-F1

A fixture `central-entradas-03-xml.test.js` agora cria, no SQLite em memória já usado pelo teste, a tabela `central_entradas_nsu` com os campos consumidos pelo `CentralNsuRepository`. São inseridos controles fictícios e isolados para cada CNPJ de teste no ambiente 1, com cursor `ult_nsu=10` e `max_nsu=11`, sem cooldown e sem último cStat de fila esgotada. O estado permite a consulta simulada sem bypass de proteção operacional.

Foi acrescentado um caso final que remove a tabela somente dessa conexão em memória, executa um ciclo com transporte simulado e verifica que a recuperação fica bloqueada, nenhuma chamada é enviada e o documento mantém seu estado. Isso preserva e verifica o comportamento fail-closed.

| Validação A-F1 | Resultado |
|---|---|
| cStat 137 no motor | **1 passou, 0 falhou.** |
| cStat 656 no motor/cooldown | **1 passou, 0 falhou.** |
| Rejeição SEFAZ simulada no motor | **1 passou, 0 falhou.** |
| Isolamento de três empresas | **1 passou, 0 falhou.** |
| Lock de ciclos simultâneos | **1 passou, 0 falhou.** |
| Documento antigo após 596 | **1 passou, 0 falhou.** |
| Suíte completa `node tests/central-entradas/central-entradas-03-xml.test.js` | **18 ok, 0 falhas**, incluindo o novo caso fail-closed. |
| `node tests/compras/rc4312-central-fluxos.test.js` | **5 ok, 0 falhas.** |
| `node --check` no teste Central e teste RC4.31.2 | **Passou.** |
| `git diff --check` | **Passou**, com aviso preexistente de normalização CRLF/LF em `backend/server.js`. |

A correção A-F1 alterou somente a preparação do banco e os testes em `tests/central-entradas/central-entradas-03-xml.test.js`; serviços operacionais não foram alterados. A página visual não foi reaberta nesta etapa.

**Conclusão atualizada:** as sete falhas anteriores estão resolvidas/classificadas: a primeira era asserção obsoleta, e as seis restantes eram causadas pela ausência do schema/estado NSU na fixture. A Sprint A-F1 passa nos testes executados. A validação visual continua não executada; este adendo não declara a validação visual concluída nem inicia a Sprint B.

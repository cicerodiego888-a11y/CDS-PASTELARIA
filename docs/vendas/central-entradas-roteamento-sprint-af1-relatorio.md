# Sprint A-F1 — Correção isolada da fixture NSU da Central

**Projeto:** CDS Sistemas — Pastelaria  
**Objetivo:** preparar a dependência NSU fictícia no teste Central sem alterar serviços operacionais ou proteções.  
**Resultado:** concluída e validada em ambiente isolado. A suíte Central XML passou com **18 ok, 0 falhas**.

## 1. Diagnóstico

O teste `tests/central-entradas/central-entradas-03-xml.test.js` substitui `backend/database` por uma conexão SQLite `:memory:`. O motor de recuperação consulta `CentralNsuService.buscarPorCnpjAmbiente` antes de chamar o transporte de consulta simulado. O serviço usa `CentralNsuRepository`, cuja consulta depende da tabela `central_entradas_nsu`.

A conexão em memória do teste não continha essa tabela. A consulta NSU falhava e o motor aplicava corretamente o bloqueio fail-closed, impedindo que cStat 137, cStat 656, rejeição simulada, isolamento, lock e recuperação de documento antigo chegassem ao comportamento que deveriam testar. A causa das seis falhas era a fixture incompleta, e não um defeito confirmado nos serviços de produção.

O contrato inspecionado foi:

- `CentralNsuService` recebe dependências de repositório/banco no construtor e delega `buscarPorCnpjAmbiente` ao repositório.
- `CentralNsuRepository` consulta `central_entradas_nsu` por CNPJ e ambiente.
- `MotorRecuperacaoXmlService` tem dependências gerais no construtor, mas constrói o serviço NSU por seu caminho existente; não foi adicionado parâmetro novo ao motor.
- O schema da tabela oficial em `backend/database.js` inclui `cnpj`, `ambiente`, cursores NSU e metadados de sincronização. A fixture também inclui as colunas de cooldown e cStat consumidas pelas versões atuais do repositório.

## 2. Alteração mínima adotada

Em `tests/central-entradas/central-entradas-03-xml.test.js`:

1. A conexão SQLite em memória foi guardada em `dbTeste`, mantendo-a como export substituto de `backend/database`.
2. Antes de iniciar a suíte, o teste cria nessa conexão uma tabela NSU compatível com as colunas consultadas pelo repositório.
3. São inseridos controles determinísticos para cada CNPJ fictício de teste no ambiente de homologação indicado pela própria fixture (`ambiente=1`). Cada controle usa `ult_nsu=10`, `max_nsu=11`, `cooldown_ate=NULL` e `ultimo_cstat=NULL`, evitando fila esgotada ou cooldown ativo.
4. A preparação é aguardada antes de executar os testes, e erros de inicialização são reportados como falha.
5. Foi acrescentado um caso final que remove a tabela somente da conexão em memória e comprova o fail-closed: ciclo bloqueado, nenhuma chamada ao transporte simulado e documento sem mudança de estado.

Nenhum serviço operacional da Central foi alterado. O teste continua usando transporte SOAP simulado; nenhum pedido real é enviado.

## 3. Resultados individuais obrigatórios

Cada cenário foi executado isoladamente no processo Node, usando a fixture corrigida e um filtro de teste aplicado apenas em memória durante a execução; não houve alteração adicional do arquivo para filtrar cenários.

| Cenário | Resultado |
|---|---|
| cStat 137 no motor | **1 passou, 0 falhou.** |
| cStat 656 no motor/cooldown | **1 passou, 0 falhou.** |
| Rejeição SEFAZ simulada no motor | **1 passou, 0 falhou.** |
| Isolamento de três empresas | **1 passou, 0 falhou.** |
| Lock de ciclos simultâneos | **1 passou, 0 falhou.** |
| Documento antigo após 596 | **1 passou, 0 falhou.** |

## 4. Regressão e validações

| Comando | Resultado |
|---|---|
| `node tests/central-entradas/central-entradas-03-xml.test.js` | **18 ok, 0 falhas**, incluindo os seis casos acima e o teste fail-closed com tabela ausente. |
| `node tests/compras/rc4312-central-fluxos.test.js` | **5 ok, 0 falhas.** |
| `node --check tests/central-entradas/central-entradas-03-xml.test.js` | **Passou.** |
| `node --check tests/compras/rc4312-central-fluxos.test.js` | **Passou.** |
| `git diff --check` | **Passou.** O Git reportou apenas o aviso preexistente de normalização CRLF/LF em `backend/server.js`, arquivo fora desta correção. |

A suíte Central foi inicialmente reproduzida com os seis erros descritos no relatório A-F; após a fixture NSU ser preparada, as seis execuções individuais e a execução integral passaram. O relatório atualizado está em [central-entradas-roteamento-sprint-af-fechamento-tecnico.md](./central-entradas-roteamento-sprint-af-fechamento-tecnico.md).

## 5. Arquivos e preservação do workspace

- `tests/central-entradas/central-entradas-03-xml.test.js` — schema, dados fictícios da fixture e regressão fail-closed.
- `docs/vendas/central-entradas-roteamento-sprint-af-fechamento-tecnico.md` — adendo com diagnóstico e resultados atuais.
- Este relatório — registro específico da Sprint A-F1.

O teste Central já tinha alterações locais anteriores para isolamento do banco e autorização de transporte de teste; elas foram preservadas e não foram substituídas por esta correção. Outros arquivos modificados/não rastreados no workspace foram mantidos.

## 6. Proteções e conclusão

- Todos os dados NSU foram criados somente na conexão SQLite `:memory:` do teste. **O banco oficial `C:\ProgramData\MercantilFiscal\dados` não foi acessado, aberto, migrado nem alterado.**
- As consultas usam transporte simulado. **Nenhuma operação real na SEFAZ foi executada.**
- O bloqueio fail-closed permanece coberto e passou.
- Não foram executados commit, push, merge, reset, rebase ou rollback destrutivo.
- A validação visual não foi iniciada, conforme o escopo desta etapa.
- Não foi iniciada a Sprint B.

**Conclusão:** a correção isolada da fixture NSU está concluída e os testes especificados passaram. Aguardar revisão do Product Owner e do Tech Lead.

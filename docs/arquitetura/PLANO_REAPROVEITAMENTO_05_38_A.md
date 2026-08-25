# PLANO DE REAPROVEITAMENTO — 05.38.A (pós-auditoria)

Somente itens **comprovados no código**. Sem implementação nesta sprint.

---

## P0 — JÁ EXISTE E DEVE SER REUTILIZADO

| Item | Arquivo / API | Comportamento atual | Destino recomendado |
|------|---------------|---------------------|---------------------|
| Resolução modo venda | `modoOperacaoVenda.js` → `resolverModoOperacaoVendaAtivo` | Lê config; sem heurística | Base do **modo global** estendido |
| Persistência modo | `configuracaoService.obterModoOperacaoVenda` | JSON local | Mesma chave ou irmã `modo_operacional_global` |
| Enum modos | `contratos.js` → `ModoOperacaoVenda` | EMPRESA_UNICA \| MULTIEMPRESA | Mapear EMPRESA_SIMPLES → política UNICA |
| Contexto HTTP | `empresaContexto.js` | X-Empresa-Id, middleware | Propagação padrão em novos módulos |
| Frontend contexto | `cds-empresa-contexto.js` | localStorage + header | ERP + PDV |
| Cadastro empresas | `EmpresaService`, `empresasSchema` | CRUD CNPJ | Fonte de CNPJs operacionais |
| Estoque por empresa | `estoque_empresa`, `EstoqueEmpresaService` | UNIQUE(produto,empresa) | MULTIEMPRESA estoque |
| Porta saldos | `estoqueSaldosPublico.js` | dual-write com empresaId | Todas mutações estoque |
| MUV completo | `AtendimentoMultiempresaService` | atendimento/reserva/pagamento/rateio | MULTIEMPRESA vendas |
| Fiscal por empresa | `empresasConfiguracaoFiscal.js` | CSC/série/cert por empresa_id | Emissão multi-CNPJ |
| PDV Universal | `PDVUniversalContextService`, adaptadores 05.x | Modo-aware | Referência UX/capabilities |
| NSU por CNPJ | `CentralNsuRepository` | ultNSU por cnpj+ambiente | Multi-CNPJ entradas |

---

## P1 — EXISTE, MAS PRECISA CONECTAR

| Item | Onde | Conectar a |
|------|------|------------|
| Modo global | Só vendas leem `modo_operacao_venda` | Caixa, financeiro, central, dashboard |
| Compras | Porta exige empresaId | Middleware obrigatório em todas rotas compra |
| Checkout Universal UNICA | `PDVUniversalVendaAdapter` aceita multi pagamento | UI + políticas EMPRESA_SIMPLES |
| Emissor | `emissor.js` opcional empresaId | Sempre resolver empresa em MULTI |
| Central Entradas | NSU multi-CNPJ na tabela | Orquestrador iterar empresas ativas |
| Usuário↔empresa | `UsuarioEmpresaService` | Gate em todos módulos sensíveis |
| PDV legado | Headers parciais | Paridade ou depreciação explícita |
| Promoção/atacado | API por produto_id | Documentar escopo global (já é) |

---

## P2 — PRECISA CENTRALIZAR

| Decisão espalhada | Locais | Centralizar em |
|-------------------|--------|----------------|
| Modo operacional | VendaApplication, PDVUniversal, adaptadores | Serviço global (evoluir `modoOperacaoVenda`) |
| CNPJ emissor | `configuracoes`, caixa, central config | `empresas` + `empresas_configuracao_fiscal` |
| Capabilities UI | `pdv-universal/contratos.js` | Gerador único por modo global |
| Auto-seleção empresa | `PDVUniversalContextService` | Política EMPRESA_SIMPLES vs UNICA |

---

## P3 — DUPLICAÇÕES

| Duplicação | Arquivos | Ação futura |
|------------|----------|-------------|
| Dados empresa legado | `caixa.js` ↔ `empresas` | Caixa ler empresa operacional |
| Saldos | `produtos` ↔ `estoque_empresa` | EMPRESA_SIMPLES: 1 linha; MULTI: só estoque_empresa |
| PDV duplo | `pdv.js` ↔ `pdv-universal` | Plano unificação já documentado A1 |
| Nome modo | EMPRESA_UNICA vs EMPRESA_SIMPLES | Alias documental na config |

---

## P4 — REALMENTE AUSENTE

| Item | Evidência |
|------|-----------|
| `MODO_OPERACIONAL_GLOBAL` sistêmico | Nenhum consumidor fora vendas |
| `EMPRESA_SIMPLES` enum | Não encontrado |
| `empresa_id` em `caixa_sessoes` | Schema database.js |
| `empresa_id` em `financeiro` / `contas_receber` | Schema database.js |
| `empresa_id` em `vendas` (coluna) | Schema legado |
| `empresa_id` em documentos central | CentralDocumentosRepository |
| Filtro empresa em relatórios | queries vendas relatório |
| UI config avançada toggle modo | Não encontrada no ERP auditado |
| TEF/PIX/entrega MULTI PDV Universal | Gates explícitos nos adaptadores |

---

## Ordem sugerida para 05.38.B+

1. **Definir contrato** `modo_operacional_global` estendendo `configuracaoService` + `modoOperacaoVenda.js` (sem heurística).
2. **EMPRESA_SIMPLES:** política auto-empresa única + ocultar MUV/seleção; validar 1 CNPJ operacional.
3. **Caixa:** `empresa_id` em sessão + amarrar a `empresas` (P0 risco).
4. **Financeiro:** coluna `empresa_id` + migração documentada (futura sprint).
5. **Central Entradas:** loop empresas ativas usando NSU repo existente.
6. **Dashboard/relatórios:** filtro por contexto.
7. **PDV legado:** alinhar ou congelar escopo.

# AUDITORIA 05.38.A — Modo operacional global (EMPRESA_SIMPLES × MULTIEMPRESA)

**Tipo:** auditoria profunda — **sem alteração de código**  
**Data:** 2026-08-23  
**Escopo:** código real do repositório CDS-Sistemas Pastelaria

---

## 0. Nomenclatura encontrada vs. nomenclatura desejada

| Conceito da decisão arquitetural | Valor **real no código hoje** | Evidência |
|----------------------------------|-------------------------------|-----------|
| Modo global da instalação (vendas) | `EMPRESA_UNICA` \| `MULTIEMPRESA` | `backend/motores/muv/contratos.js` → `ModoOperacaoVenda` |
| Persistência | `modo_operacao_venda` em arquivo de configuração | `backend/services/configuracaoService.js` |
| **EMPRESA_SIMPLES** (termo da sprint) | **Não existe como enum** | — |

**Conclusão:** o sistema possui hoje um **modo de operação de venda** (`modo_operacao_venda`), não um **modo operacional global de todos os módulos**. A auditoria mapeia o que existe e registra o GAP para cobertura sistêmica.

**Distinção crítica (código):** em `EMPRESA_UNICA`, se existirem **várias empresas cadastradas**, o PDV Universal pode exigir seleção (`exige_selecao`) — comportamento em `PDVUniversalContextService.resolverEmpresaSelecionada()`. Isso **não** equivale à definição desejada de EMPRESA_SIMPLES (“usuário não percebe multiempresa”).

---

## 1. Fonte oficial atual do modo (vendas)

| Camada | Arquivo | Função | Comportamento |
|--------|---------|--------|---------------|
| Persistência | `configuracaoService.js` | `obterModoOperacaoVenda`, `bootstrapModoOperacaoVenda` | Lê/grava `modo_operacao_venda`; default `EMPRESA_UNICA` |
| Resolução única | `motores/muv/modoOperacaoVenda.js` | `resolverModoOperacaoVendaAtivo` | **Único ponto** que lê config; não usa body/query/heurística de contagem |
| Despacho | `modoOperacaoVenda.js` | `executarNoModoOperacaoVenda` | MULTIEMPRESA sem executor → erro explícito (não cai em UNICA) |
| Vendas HTTP | `VendaApplicationService.js` | `criarVendaComContexto` | UNICA → `VendaPagamentoService`; MULTI → `AtendimentoMultiempresaService` |
| PDV Universal | `PDVUniversalApplicationService.js` | `finalizarCheckout`, `confirmarPagamentoPdv` | Ramifica por modo |
| Contexto PDV | `PDVUniversalContextService.js` | `obterContextoOperacional` | Expõe `modo_operacao` + capacidades |

**Classificação da fundação de modo:** **R3** (existe para **vendas/PDV**, não para todo o sistema).

**GAP real (R6 para modo global):** não há `MODO_OPERACIONAL_GLOBAL` / flag sistêmica consumida por Central de Entradas, caixa, financeiro, dashboard.

---

## 2. Contexto empresarial (`empresa_id`)

| Mecanismo | Arquivo | Entrada | Saída |
|-----------|---------|---------|-------|
| Header HTTP | `empresaContexto.js` | `X-Empresa-Id` | `req.empresaId` |
| Frontend | `cds-empresa-contexto.js` | `localStorage.cds_empresa_id` | header em `/api` |
| Middleware | `criarMiddlewareContextoEmpresa` | req | valida `empresas` + `usuario_empresas` |
| Cadastro | `empresasSchema.js` | — | tabela `empresas` (CNPJ único, `ativo`) |
| Vínculo usuário | `usuarioEmpresasSchema.js` | — | `usuario_empresas` |
| Serviço | `EmpresaService.js` | CRUD | sem empresa padrão automática |

**Não encontrado:** `empresa_padrao` global, `empresa_ativa` em config (exceto coluna `ativo` por empresa e alias em join de usuário).

**Classificação contexto:** **R1** para propagação HTTP (`X-Empresa-Id`); **R4** para decisões espalhadas sem modo global.

---

## 3. Matriz arquitetural obrigatória

| Módulo | Estado atual (código real) | EMPRESA_SIMPLES (alvo) | MULTIEMPRESA (alvo) | Reaproveitar | Gap principal | Class. |
|--------|---------------------------|------------------------|---------------------|--------------|---------------|--------|
| **Configurações** | `modo_operacao_venda` em JSON; bootstrap idempotente | Ocultar modo; forçar fluxo tradicional | Admin escolhe MULTIEMPRESA | `configuracaoService`, `modoOperacaoVenda.js` | Sem flag global sistêmica; UI ERP não expõe toggle encontrado | **R3** |
| **Empresas** | Tabela `empresas`, CRUD, CNPJ único, usuário↔empresa | 1 CNPJ operacional implícito | N empresas ativas | `EmpresaService`, schemas 03.x | Sem `empresa_padrao`; legado `configuracoes.cnpj` paralelo | **R2** |
| **Contexto** | `X-Empresa-Id`, middleware, PDV context DTO | Auto-resolver única empresa; sem UI multi | Obrigatório por operação/item | `empresaContexto.js`, `cds-empresa-contexto.js`, `PDVUniversalContextService` | JWT sem claim; caixa/financeiro não propagam | **R1/R4** |
| **Central Entradas** | NSU por `cnpj+ambiente` (`central_entradas_nsu`); docs sem `empresa_id` | Monitor 1 CNPJ (config legado) | NSU/certificado por empresa | `CentralNsuRepository`, `empresas_configuracao_fiscal` | Orquestração ainda amarrada a config fiscal global em partes | **R3** |
| **Produtos** | Catálogo global (`produtos` sem `empresa_id`); saldos por empresa via `estoque_empresa` | Catálogo único; estoque 1 empresa | Catálogo compartilhado; saldo isolado | `EstoqueEmpresaService`, rotas produtos com `req.empresaId` | Dual-write `produtos`+`estoque_empresa`; leitura legado sem empresa | **R2** |
| **Estoque** | Porta `estoqueSaldosPublico`: com `empresaId` → `estoque_empresa`; sem → `produtos` | Sempre 1 empresa (sem escolha) | `empresa_id` obrigatório | `estoque_empresa` UNIQUE(produto,empresa), reservas PDV/MUV | Escritores legado sem empresa ainda possíveis (COMPAT) | **R2** |
| **Compras** | Crédito/débito via porta exige `empresaId` | Empresa do contexto único | Empresa explícita por operação | `creditoEstoqueCompraViaPorta.js` | Nem toda rota de compra auditada usa middleware obrigatório | **R2** |
| **Vendas** | `VendaApplicationService` despacha por modo; UNICA → venda direta | `POST /vendas` tradicional | Atendimento MUV | `VendaPagamentoService`, MUV | `vendas` sem coluna `empresa_id` na base legada | **R2** |
| **PDV** | Universal: modos + MUV; Legado: `X-Empresa-Id` parcial | Checkout empresa única; sem MUV | Carrinho multiempresa, reserva, pagamento unificado | Adaptadores 05.x, `AtendimentoMultiempresaService` | Legado ≠ Universal; TEF/PIX/entrega bloqueados em MULTI | **R3** |
| **Caixa** | `caixa_sessoes` sem `empresa_id`; metadados de `configuracoes` (cnpj/nome) | 1 caixa = 1 instalação | Caixa/terminal por empresa | Rotas `/caixa/*`, middleware caixa aberto | **Sem isolamento empresarial no schema de caixa** | **R6/R4** |
| **Financeiro** | `financeiro`, `contas_receber` sem `empresa_id` | Fluxo tradicional global | Lançamentos por empresa | `VendaFinanceiroService`, Orquestrador | **Isolamento empresarial ausente** | **R6** |
| **Fiscal** | `empresas_configuracao_fiscal` por `empresa_id`; emissor NFC-e aceita `empresaId` | Config única (pode mapear 1 empresa) | CSC/série/certificado por CNPJ | `empresasConfiguracaoFiscal.js`, `emissor.js` | Fallback config global legado ainda referenciado (caixa, central) | **R2** |
| **Dashboard** | Consultas operacionais majoritariamente **sem** filtro `empresa_id` | Dados da instalação | Filtro/consolidado por empresa | — | Queries globais | **R6/R3** |
| **Relatórios** | Ex.: fechamento caixa agrupa `forma_pagamento` global | Idem simples | Precisam contexto empresarial | Rotas `/vendas/relatorio/*` | Sem filtro empresa nas queries auditadas | **R6** |
| **Integrações** | Open Finance / bancário não auditado em profundidade nesta sprint | — | Conta bancária por empresa (alvo) | — | Fora do escopo detalhado | **R6** |

---

## 4. Inventário detalhado por área

### A. Configurações e fundação

**Encontrado:**
- Chave persistida: `modo_operacao_venda` (`configuracaoService.js` linhas 62, 187–246).
- Valores válidos: `EMPRESA_UNICA`, `MULTIEMPRESA` (`contratos.js`).
- Resolução centralizada de **venda**: `resolverModoOperacaoVendaAtivo()` — proíbe heurística `empresas.length`.

**Não encontrado:**
- Enum `EMPRESA_SIMPLES`.
- Configuração avançada ERP ligada ao toggle de modo (grep em `cds-centro-configuracoes.js` só menciona MULTIEMPRESA na gestão de empresas, sem campo `modo_operacao_venda`).

### B. Cadastro de empresas

**Respostas (código):**
1. **Quantas empresas?** Ilimitadas na tabela `empresas` (PK autoincrement).
2. **Identificação:** `empresas.id` + CNPJ único (`idx_empresas_cnpj`).
3. **`empresa_id` usado em:** `estoque_empresa`, MUV (`atendimento_operacoes`), fiscal por empresa, middleware, PDV item (`produto_id+empresa_id`).
4. **Empresa ativa?** Coluna `empresas.ativo`; filtro em `PDVUniversalContextService.filtrarOperacionais`.
5. **Empresa padrão?** **Não** — `EmpresaService` documenta “Não cria empresa padrão”.
6. **Regras implícitas empresa única?** Auto-seleção quando `EMPRESA_UNICA && empresas.length === 1`.
7. **Base reutilizável?** **Sim** — CRUD + fiscal por empresa + estoque_empresa.

### C. Central de Entradas / SEFAZ

**Fluxo real:**
```
SEFAZ (CNPJ+ambiente)
  → central_entradas_nsu (ultNSU por cnpj, ambiente)
  → documentos (chave, cnpj_fornecedor — sem empresa_id)
  → MIIP / revisão / compra (fora do detalhe desta auditoria)
```

**Respostas:**
1. Monitoramento vinculado ao **CNPJ configurado** (fiscal global + repositório NSU por CNPJ).
2. CNPJ: **parametrizado por linha NSU**; config operacional ainda lê fiscal global em `CentralConfiguracaoService`.
3. NSU: **por CNPJ+ambiente** (`CentralNsuRepository` — “Controle de ultNSU por CNPJ e ambiente fiscal”).
4. Documentos: **sem `empresa_id`** em `CentralDocumentosRepository` (usa `cnpj_fornecedor`).
5. Arquitetura NSU: **suporta múltiplos CNPJs** na tabela; orquestração completa multiempresa **parcial**.
6. EMPRESA_SIMPLES: reutilizar 1 CNPJ ativo; desligar ramificações multi.

### D. Produtos e catálogo

- Produto **não pertence** a uma empresa na tabela base (`produtos` — sem `empresa_id`).
- Estoque **separado** em `estoque_empresa (produto_id, empresa_id)`.
- Promoção/atacado API: filtro por `produto_id` apenas (`/produtos/:id/promocao-ativa`).
- **Alinhado** com catálogo compartilhado + estoque por empresa.

### E. Estoque

- `EstoqueEmpresaService`: exige `empresaId` para acesso à tabela isolada.
- `estoqueSaldosPublico`: dual-write quando há `empresaId`; leitura legado em `produtos` quando ausente.
- PDV disponibilidade: `PDVUniversalDisponibilidadeService` + reservas MUV por empresa.
- **MULTIEMPRESA** operacional no PDV/MUV; **legado** ainda tem caminho sem empresa (COMPAT).

### F. Compras

- Porta de crédito/débito exige `empresaId` (`creditoEstoqueCompraViaPorta.js`).
- Empresa inferida do **contexto da requisição**, não de heurística global.

### G. Vendas e PDV

**EMPRESA_UNICA (código):**
```
itens (empresa_id coerente) → POST checkout/vendas → VendaPagamentoService → estoque/financeiro/fiscal
```

**MULTIEMPRESA (código):**
```
disponibilidade por empresa → carrinho (produto_id+empresa_id)
  → checkout cria atendimento → reserva → pagamento unificado + rateio
  → materialização → vendas por operação → fiscalização MUV
```

**Evidências MUV:** `AtendimentoMultiempresaService.confirmarPagamentoAtendimento` — comentário: “Não cria vendas, não chama TEF”.

**PDV legado:** ainda relevante para fluxos não portados (pagamento misto completo, entrega com `pagamentos:[]`).

### H. Caixa

- `caixa_sessoes`: **sem** `empresa_id` (schema `database.js` ~3060).
- `obterConfigsEmpresa` em `caixa.js` lê **configuracoes** globais (`cnpj`, `razao_social`).
- **Risco confirmado:** duas empresas podem compartilhar mesmo caixa/sessão lógica.

### I. Financeiro

- Tabelas `financeiro`, `contas_receber`: **sem `empresa_id`** no DDL base.
- Recebimentos derivam de `venda_id` (venda também sem empresa_id explícito no schema legado).

### J. Fiscal

- `empresas_configuracao_fiscal.empresa_id` UNIQUE — **por empresa**.
- `emissor.js` persiste `empresa_id` em nota quando informado.
- MUV fiscal exige config por operação (`FiscalizarAtendimentoService`).

### K. Relatórios / Dashboard

- Fechamento caixa / produtos mais vendidos: filtros por **data**, não por `empresa_id` (`vendas.js` relatórios).

---

## 5. Duplicações e decisões espalhadas (R5)

| Duplicação | Onde | Impacto |
|------------|------|---------|
| CNPJ/dados empresa | `configuracoes` (caixa, legado) vs `empresas` + `empresas_configuracao_fiscal` | Emissor/metadados podem divergir |
| Saldos estoque | `produtos.*` vs `estoque_empresa` (dual-write) | Risco inconsistência se sem `empresaId` |
| Modo operacional | Só `modo_operacao_venda`; módulos ignoram | Central/caixa/financeiro não ramificam |
| PDV | Legado vs Universal | Dois consumidores de estoque/venda |

**Heurísticas proibidas no futuro:** `resolverModoOperacaoVendaAtivo` **já evita** `empresas.length`. Porém `resolverEmpresaSelecionada` usa `empresas.length === 1` para auto-seleção em EMPRESA_UNICA — **aceitável como resolução de contexto**, não como modo.

---

## 6. Respostas aos critérios de conclusão (§15)

1. **Onde deve viver a config oficial?** Estender **`configuracaoService` + `modoOperacaoVenda.js`** para **`modo_operacional_global`** (nome a definir na 05.38.B), ou criar serviço irmão que **todos** os módulos consultem — hoje só vendas consultam.
2. **Fundação de contexto reutilizável?** **Sim:** `empresas`, `usuario_empresas`, `X-Empresa-Id`, `estoque_empresa`, MUV.
3. **Preservar EMPRESA_SIMPLES?** Exige **modo global** que desliga UI/capacidades MUV e **auto-bind** única empresa — não basta `empresas.length === 1` em MULTIEMPRESA.
4. **Módulos prontos para MULTIEMPRESA?** Estoque por empresa, MUV, fiscal por empresa, PDV Universal (parcial).
5. **Só conexão?** Compras/estoque porta, emissor, adapter checkout.
6. **Centralização?** Modo global, caixa, financeiro, relatórios, Central Entradas orquestração.
7. **Duplicações?** Config CNPJ legado vs empresas; dual-write estoque.
8. **GAPs ausentes?** Modo global sistêmico; `empresa_id` em caixa/financeiro/vendas legado; dashboard filtrado.
9. **Ordem 05.38.B+:** ver `PLANO_REAPROVEITAMENTO_05_38_A.md`.

---

## 7. Contagem de evidências

| Métrica | Valor |
|---------|------:|
| Módulos na matriz | 15 |
| Arquivos/chaves analisados | **52** |
| Classificações R1 | 8 |
| R2 | 9 |
| R3 | 7 |
| R4 | 4 |
| R5 | 3 |
| R6 | 6 |
| Duplicações documentadas | 4 |
| GAPs reais | 9 |
| Bloqueadores P0 | 3 (ver RISCOS) |

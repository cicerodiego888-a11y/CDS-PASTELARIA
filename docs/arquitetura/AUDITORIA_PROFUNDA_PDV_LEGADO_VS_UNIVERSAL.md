# AUDITORIA PROFUNDA — PDV LEGADO vs PDV UNIVERSAL

**Sprint:** 05.19.1  
**Tipo:** auditoria. **Nenhuma remoção. Nenhum motor alterado. Nenhum terceiro PDV.**

Documentos irmãos:

1. Este arquivo  
2. `MAPA_REAL_PDV_LEGADO.md`  
3. `MAPA_REAL_PDV_UNIVERSAL.md`  
4. `MATRIZ_FUNCIONAL_LEGADO_VS_UNIVERSAL.md`  
5. `MATRIZ_VISUAL_LEGADO_VS_UNIVERSAL.md`  
6. `PLANO_UNIFICACAO_PDV_UNICO.md`  
7. `LISTA_CODIGO_OBSOLETO_PDV_LEGADO.md`  
8. `LISTA_FUNCIONALIDADES_EXCLUSIVAS_LEGADO.md`  
9. `LISTA_FUNCIONALIDADES_JA_EXISTENTES_UNIVERSAL.md`  

---

## 1. Os dois PDVs (confirmado)

| | PDV legado | PDV Universal |
|--|------------|---------------|
| Rota | `/pdv` | `/pdv-universal/` |
| HTML | `frontend/pdv/index.html` + `pages/pdv.html` | `frontend/pdv-universal/index.html` |
| JS núcleo | `pdv.js` + satélites | `pdv-universal.js` + módulos |
| Finalização browser | **`POST /api/vendas`** | **`POST /api/pdv-universal/checkout`** |
| Motor | VAS direto (HTTP vendas) | EU: VAS in-process; ME: MUV → materializar → VAS |

Cadeia legado:

```
ROTA → HTML → JS → EVENTOS → POST /api/vendas → VAS → persistência
```

Cadeia Universal:

```
ROTA → HTML → JS → EVENTOS → /api/pdv-universal/* → (VAS | MUV) → persistência
```

---

## 2. Inventário tela a tela (legado)

### A. Header (`pdv.html`)

| Elemento | Visual / lógica | API |
|----------|-----------------|-----|
| Marca `CDS SISTEMAS` | Visual + branding | — |
| Menu hamburger | Lógica UI (`menu-open`) | — |
| Aparência F11 | Lógica tema | localStorage / CSS |
| Calculadora | Só UI | — |
| Status caixa | Lógica | `GET /api/caixa/aberto` |
| Fechar caixa | Lógica | fluxo `caixa.js` / F7 |
| Operador | Lógica (sessão) | token / user |
| Data/hora | UI (timer 1s) | — |
| Faixa fiscal | Visual ligado a modo sistema | helpers fiscal |

Universal: marca, operador, **modo**, **empresa**. Sem caixa/relógio/calculadora.

### B. Busca

```
#buscaProdutoPdv
  → PdvBuscaProduto (input / ENTER)
  → GET /produtos/identificar  e/ou  consulta-pdv/buscar
  → seleção
  → quantidade (modal ou 1)
  → etiqueta? POST /equipamentos/etiquetas/interpretar
  → validarEstoqueVenda
  → item no carrinho[]
```

F1 abre consulta modal (não só foco).  
Universal: busca texto + disponibilidade; **sem** identificar/etiqueta.

### C. Carrinho

Colunas: Qtd, UN, Produto, Unitário, Desc %, Desc R$, Total, remover.  
Regras no frontend: estoque fiscal/não fiscal, peso médio, fracionado, promoção, atacado.  
Universal: linhas simples + `empresa_id`.

### D. Resumo financeiro

Subtotal, desconto atacado, itens, desconto, acréscimo, TOTAL.  
Cálculo: **frontend** para UI; distribuição fiscal **backend** (`pre-calcular-distribuicao`) com fallback local.  
Persistência final: VAS.  
Universal: total do cart; totais oficiais no checkout/MUV.

### E. Tipo da venda

- **Balcão:** F10 / `#btnFinalizarVendaPdv`.  
- **Entrega:** F9 / `#btnVendaEntregaPdv` se `vendasEntrega`.  
Universal: um tipo — atendimento PDV. Sem transição entrega.

### F. Finalização

Abre fluxo de pagamento (formas, TEF, PIX, dinheiro/troco, prazo).  
**API que grava a venda: `POST /api/vendas`.** Confirmado em `pdv.js` `enviarVenda` e em `pdv-venda-entrega.js`.  
Universal **não** usa essa rota no browser.

### G. Entrega

Módulo: criar venda entrega, fila `entregas.js`, prestação, widgets.  
Universal: **nenhuma** parte desse fluxo na UI.

### H. Caixa

Página + header. APIs `/api/caixa/*`.  
Universal: apenas `validarCaixaSeOrigemPdv` no checkout. **Não migrar automaticamente.**

### I. Balança / pesagem

| | Legado | Universal | Motor Equipamentos |
|--|--------|-----------|-------------------|
| F7 | **Fechar caixa** | — | — |
| Etiqueta | `POST /equipamentos/etiquetas/interpretar` | Não | **Já existe** — reusar |
| Peso contínuo UI | Não encontrado | Não | Drivers Toledo no backend; PDV não consome live |
| PLU | identificar | busca texto | — |

**Não duplicar serviços.** Universal “já tem arquitetura de pesagem” no **backend de equipamentos**, não na tela.

### J. Atalhos

| Atalho | Ação legado | Universal | Status |
|--------|-------------|-----------|--------|
| F1 | Consulta modal | Foco busca | **Conflito de semântica** — prevalece Universal |
| F2 | Foco busca | — | ATIVO MAS LEGADO |
| F4 | Qtd | — | A MIGRAR (opcional) |
| F7 | Fechar caixa | — | A MIGRAR com caixa; não é peso |
| F8 | Desconto | — | A MIGRAR |
| F9 | Entrega | — | A MIGRAR |
| F10 | Finalizar | — | A MIGRAR → mesmo checkout Universal |
| F11 | Aparência | — | Opcional |
| F12 | Sem binding | — | CÓDIGO MORTO |
| ESC | Cancela venda | Fecha modal | **Conflito** — prevalece regra Universal no pagamento |

### K. Pagamentos

| Forma | Legado | Universal | Classificação |
|-------|--------|-----------|---------------|
| Dinheiro | UI + troco + VAS | Enum + valor | ATIVO MAS LEGADO / A MIGRAR UX |
| PIX | `/api/pix/*` e/ou TEF | Enum sem cobrança | A MIGRAR |
| Débito/crédito | TEF real | Enum | A MIGRAR |
| Misto | Sim | Linhas modal | Parcial Universal |
| Prazo | Cliente + parcelas | Não | A MIGRAR |
| TEF | Integração real | Ausente | RISCO DE REGRESSÃO |

---

## 3–4. Visual e arquitetura

Ver matrizes. Legado: **UX operacional**. Universal: **pipeline correto**.

Duplicações do legado: carrinho próprio, totais no cliente, `POST /api/vendas` paralelo à fachada Universal, TEF/PIX só no monolito.

```
PDV LEGADO
  → /api/vendas, /api/caixa, /api/tef, /api/pix, /api/produtos, /equipamentos/etiquetas
  → VendaApplicationService
  → Estoque / Fiscal / Financeiro

PDV UNIVERSAL
  → /api/pdv-universal
  → MUV (se MULTIEMPRESA)
  → VendaApplication
  → Estoque / Fiscal / Financeiro
```

Lacunas do Universal = lista exclusiva do legado.

---

## 5. Multiempresa

| | Legado | Universal |
|--|--------|-----------|
| Desenho original | Empresa única + header opcional `X-Empresa-Id` | Oficial EU + ME |
| Estoque na busca | Saldos do produto (fiscal/não fiscal) | Disponibilidade **por empresa** |
| Fiscal | Emissão por `venda_id` (empresa da venda/contexto) | Fiscalizar por operação/empresa |
| Certificado / CSC / NFC-e | Via venda + config fiscal da empresa da venda | Mesma cadeia no MUV (sprints 05.18.x) |

**Não migrar** regra de empresa fixa / empresa 1 do legado.

---

## 6–7. Plano e fórmula

Ver `PLANO_UNIFICACAO_PDV_UNICO.md`.

---

## 8. Critério para remover o legado

O `/pdv` **não** pode ser removido antes de comprovar no **PDV Universal**:

| # | Critério | Situação 05.19.1 |
|---|----------|------------------|
| 1 | Busca produtos | Parcial (consulta-pdv) |
| 2 | Código de barras | Parcial (sem identificar) |
| 3 | PLU | Não comprovado |
| 4 | Quantidade | Básico |
| 5 | Peso | Não na UI |
| 6 | Carrinho | Sim (simples) |
| 7 | Desconto | Não |
| 8 | Acréscimo | Não |
| 9 | PIX | Enum apenas |
| 10 | Dinheiro | Enum; troco frágil |
| 11 | Débito | Enum; sem TEF |
| 12 | Crédito | Enum; sem TEF |
| 13 | Misto | Modal linhas |
| 14 | TEF preservado | **Não** |
| 15 | Fiscal | ME sim; EU via VAS |
| 16 | Não fiscal | Via VAS; UX legado mais rica |
| 17 | Estoque | Disponibilidade ME; sem split fiscal UI |
| 18 | Caixa | Só validação checkout |
| 19 | Entrega | **Não** |
| 20 | Cancelamento | Atendimento; não venda em curso estilo legado |
| 21 | Comprovante | Sim (oficial) |
| 22 | Multiempresa | Sim |
| 23 | Empresa única | Sim (adaptador) |
| 24 | Atalhos | Só F1/ESC oficiais |
| 25 | Integrações | TEF/PIX/etiqueta/caixa/entrega ausentes na UI |

**Conclusão:** legado **não** é removível nesta sprint.

---

## 9. Respostas da definição de sucesso

1. **Tudo no legado:** mapas + exclusivas + matriz.  
2. **Tudo no Universal:** mapa + lista existentes.  
3. **O que absorver:** exclusivas (TEF, PIX real, entrega, caixa UI, busca MIP, peso/etiqueta, descontos, prazo, shell).  
4. **Reaproveitar visualmente:** header denso, busca, tabela, TOTAL, botões, chips.  
5. **Reescrever:** bindings e CSS no Universal; não `pdv.js`.  
6. **Obsoleto:** comentário F12, F7=peso, calc fiscal no client como verdade, porta `/api/vendas` como UI oficial.  
7. **Quando remover:** após tabela §8 toda comprovada + Fases 6–7.  
8. **Arquitetura do único PDV:**

```
CDS SISTEMAS
    ↓
PDV UNIVERSAL
    ↓
Empresa Única / Multiempresa
    ↓
Motor Universal de Vendas
    ↓
Fiscal + Estoque + Financeiro + Equipamentos
```

Sem PDV duplicado. Sem motor paralelo. Sem funcionalidade perdida (absorção antes do delete).

---

## Estado da sprint

**ESTADO A (documentação):** auditoria baseada em código.  
**Não** houve alteração de runtime.  
**Não** houve validação visual desta sprint (escopo documental).

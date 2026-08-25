# MAPA REAL DE EXECUÇÃO — PDV UNIVERSAL

**Sprint:** 05.19.1  
**Fonte:** código confirmado. Sem implementação.

## Rota HTTP (tela)

| Item | Valor confirmado |
|------|------------------|
| Rotas | `GET /pdv-universal` e `GET /pdv-universal/` |
| Arquivo | `backend/server.js` (~201–206) |
| Auth | `verificarToken` |
| Licença | mesmo recurso `pdv` |
| HTML | `frontend/pdv-universal/index.html` |
| URL oficial | `frontend/shared/js/pdv-acesso-oficial.js` → `/pdv-universal/` |
| Menu ERP | `href="/pdv-universal/"` (destaque success) |
| Link cruzado | header Universal → `/pdv` (legado) e `/erp` |

## API fachada

`app.use('/api/pdv-universal', verificarToken, …)` → `backend/rotas/pdv-universal.js`

| Método | Caminho | Serviço |
|--------|---------|---------|
| GET | `/contexto` | `obterContexto` |
| POST | `/contexto/empresa` | `selecionarEmpresa` (rota complementar no mesmo arquivo) |
| GET | `/produtos/:produtoId/disponibilidade` | estoque por empresa |
| POST | `/checkout` | `finalizarCheckout` + `validarCaixaSeOrigemPdv` |
| POST | `/atendimentos/:id/reservar` | reserva MUV |
| POST | `/atendimentos/:id/pagamento` | pagamento unificado |
| POST | `/atendimentos/:id/cancelar` | cancelar atendimento |
| POST | `/atendimentos/:id/materializar` | materializar vendas |
| POST | `/atendimentos/:id/fiscalizar` | fiscalizar |
| GET | `/atendimentos/:id/comprovante` | comprovante unificado |
| POST | `/atendimentos/:id/imprimir` | preparar impressão |

## HTML / CSS / JS

| Papel | Arquivo |
|-------|---------|
| HTML único | `frontend/pdv-universal/index.html` |
| CSS | `/css/style.css` + `pdv-universal/pdv-universal.css` |
| Sessão / atalhos | `pdv-universal-session.js` |
| Carrinho memória | `pdv-universal-cart.js` |
| Checkout | `pdv-universal-checkout.js` |
| Reserva/pagamento | `pdv-universal-pagamento.js` |
| Materializar/fiscal | `pdv-universal-pos-pagamento.js` |
| Comprovante | `pdv-universal-comprovante-modal.js` + `muv-comprovante-client.js` |
| Tela | `pdv-universal.js` |

**Não carrega:** `pdv.js`, `caixa.js`, `entregas.js`, `tefFluxoPagamento.js`, `pdvBuscaProduto.js`, temas F11.

## Eventos / atalhos

Confirmados em `pdv-universal.js` `bindUi`:

| Tecla | Ação |
|-------|------|
| F1 | Foco `#pdvu-busca-input` |
| ESC | Fecha modal pagamento / comprovante **sem** cancelar pagamento (domínio) |
| ENTER | Bloqueado se `atalhoPermitido` for falso |

**Não existem** F4, F7, F8, F9, F10, F11, F12 no Universal.

Footer da tela: texto “F1 — Buscar produto. ESC fecha modal sem cancelar pagamento.”

## Busca e carrinho

```
#pdvu-busca-input
  → GET /api/produtos/consulta-pdv/buscar?q=
  → seleção
  → GET /api/pdv-universal/produtos/:id/disponibilidade
  → (MULTIEMPRESA) modal empresa do item
  → PdvUniversalCart (memória, item com empresa_id)
  → #pdvu-linhas-carrinho + totais
```

## Checkout — dois modos (mesmo endpoint)

`PDVUniversalApplicationService.finalizarCheckout` lê `resolverModoOperacaoVendaAtivo()`:

### EMPRESA_UNICA

```
POST /api/pdv-universal/checkout
  → EmpresaUnicaAdapter.criarVenda
  → VendaApplicationService.criarVenda (in-process)
  → persistência de venda (mesmo motor do legado)
```

O **browser não chama** `POST /api/vendas`. O adaptador chama o VAS internamente.

### MULTIEMPRESA

```
POST /api/pdv-universal/checkout
  → AtendimentoMultiempresaService.criarAtendimento
  → atendimento AGUARDANDO PAGAMENTO
  → POST .../reservar
  → POST .../pagamento
  → POST .../materializar  → VAS por operação / empresa
  → POST .../fiscalizar    → FiscalizarAtendimentoService (empresa da operação)
  → GET comprovante
```

## Contexto multiempresa

- Header: modo + empresa selecionada + botão SELECIONAR EMPRESA.
- `GET /contexto` pode responder 409 `NENHUMA_EMPRESA_DISPONIVEL` (operacional, não logout).
- Capacidade `checkout_multiempresa` vs `checkout_empresa_unica` (`pdv-universal-checkout.js`).

## Pagamento (UI atual)

Select simples: dinheiro, PIX, débito, crédito. Modal unificado: múltiplas linhas + valores.

**Não há** no frontend Universal:

- TEF (`/api/tef/*`)
- PIX cobrança (`/api/pix/*`)
- Prazo / cliente / parcelas
- Troco operacional (só diferença de valor no modal)
- Entrega F9
- Tela de caixa
- Pesagem / etiqueta / MIB
- Desconto % / R$ por item, desconto atacado, acréscimo de resumo

## Motor e persistência

```
ROTA /pdv-universal/
  → index.html + pdv-universal.js
  → GET /api/pdv-universal/contexto
  → eventos (busca / finalizar)
  → POST /api/pdv-universal/checkout
      EMPRESA_UNICA → VendaApplicationService
      MULTIEMPRESA  → MUV atendimento
          → reserva / pagamento / materializar
          → VendaApplication (por empresa)
          → Estoque / Fiscal / Financeiro
```

## Diagrama oficial (já existente)

```
CDS SISTEMAS
    ↓
PDV UNIVERSAL (única fachada oficial futura)
    ↓
resolverModoOperacaoVendaAtivo()
    ├── EMPRESA_UNICA → VendaApplicationService
    └── MULTIEMPRESA  → MUV → materializar → VendaApplication (por empresa)
                              → Fiscal + Estoque + Financeiro
```

Motor Equipamentos existe no backend; **a tela Universal não o consome**.

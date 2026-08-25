# IMPLEMENTAÇÃO 05.34 — Entrega no PDV Universal

**Tipo:** implementação cirúrgica (Auditoria A1 — entrega, 1ª etapa)  
**Classificação:** **ESTADO B** (código + testes automatizados; sem venda de entrega manual real)

---

## 1. APIs existentes reutilizadas

| Uso | Método | Rota |
|-----|--------|------|
| Criar venda para entrega | `POST` | `/api/vendas` — payload `tipo_venda: 'ENTREGA'` (mesmo contrato do `pdv-venda-entrega.js`) |
| Listar clientes | `GET` | `/api/clientes?limit=200` |

Sem uso de rotas novas. Checkout balcão continua em `POST /api/pdv-universal/checkout`.

---

## 2. Arquivos alterados

| Arquivo | Alteração |
|---------|-----------|
| `frontend/pdv-universal/pdv-universal-entrega.js` | **Novo** — adaptador payload + HTTP |
| `frontend/pdv-universal/pdv-universal.js` | Modalidade BALCÃO/ENTREGA, modal, FINALIZAR condicional |
| `frontend/pdv-universal/index.html` | Toggle modalidade + modal entrega + script |
| `frontend/pdv-universal/pdv-universal.css` | Estilos mínimos |
| `tests/pdv-universal/entrega-integracao-05-34.test.js` | **Novo** — 11 casos |

---

## 3. Fluxo BALCÃO × ENTREGA

**BALCÃO (padrão):** inalterado — FINALIZAR → checkout Universal (dinheiro/PIX/TEF).

**ENTREGA:**
1. Operador escolhe **Entrega**
2. Modal: cliente (GET `/clientes`) + endereço mínimo
3. Confirmar → `POST /api/vendas` com payload legado
4. Sucesso → carrinho limpo, volta a BALCÃO
5. FINALIZAR em modo ENTREGA abre o modal (não executa checkout balcão)

Cancelar modal → volta a **BALCÃO** (carrinho intacto).

---

## 4. Comportamento MULTIEMPRESA

Bloqueio explícito: `ENTREGA_MULTIEMPRESA_AINDA_NAO_IMPLEMENTADA`  
Somente `EMPRESA_UNICA` habilitada nesta sprint.

---

## 5. Testes executados

```text
node tests/pdv-universal/entrega-integracao-05-34.test.js     → 11/11
node tests/pdv-universal/checkout-empresa-unica-05-05.test.js → (regressão)
node tests/pdv-universal/checkout-multiempresa-05-06.test.js  → (regressão)
```

---

## 6. O que não foi alterado

- `EntregaService`, `backend/rotas/entregas.js`, banco
- PDV legado (`pdv-venda-entrega.js`, `entregas.js`)
- `pdv-universal-checkout.js` / checkout balcão
- MUV, VAS, TEF, PIX, Caixa, motor fiscal, `PDVUniversalCart`
- Gestão de entregadores, prestação, dashboard, mapa, voucher

**Fora do escopo desta etapa:** pagamento na entrega via checkout Universal; logística avançada.

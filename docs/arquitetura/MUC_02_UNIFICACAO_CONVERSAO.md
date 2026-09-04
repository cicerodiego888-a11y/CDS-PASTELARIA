# MUC-02 — Unificação da conversão (SI + encadeamento)

**Status:** evoluído sobre RC2.1 (não reconstruído).  
**Autoridade:** `obterMuc(db)` — quantidade oficial via `converterQuantidade` / pipeline de compra.

O MUC calcula `quantidade + unidade origem → quantidade + unidade destino`. Não conhece empresa, venda, estoque, financeiro nem fiscal.

---

## Arquitetura

```
                 MUC
                  │
      ┌───────────┼───────────┐
      ▼           ▼           ▼
   Compras      Ficha      simular / cadastro (MUC-03)
      │           │
      └─────┬─────┘
            ▼
     Estoque (empresa_id do consumidor)
```

Núcleo puro: `backend/motores/muc/core/MotorConversaoQuantidade.js`  
Catálogo SI: `backend/motores/muc/core/unidadesSi.js`

---

## API

Contrato RC2.1 (7 métodos) **preservado**. Extensão:

`muc.converterQuantidade({ quantidade, unidadeOrigem, unidadeDestino, relacoes? })`

`relacoes`: `{ de, para, fator }` — 1 origem = fator destino. Inverso automático na busca.

`processarItemCompra` monta relações a partir de apresentações do produto + fator da UC + `item.relacoes` / `opcoes.relacoes`. Destino = `produtos.unidade`.

`simular({ ..., unidadeOrigem, unidadeDestino, relacoes })` — opcional; sem destino permanece multiplicador legado.

---

## SI

Famílias: MASSA (G, KG), VOLUME (ML, L), COMPRIMENTO (MM, CM, M), UN.

Incompatíveis (KG→L) sem relação explícita: `CONVERSAO_INVALIDA`. Densidade não implementada.

---

## Encadeamento

Ex.: CAIXA ×12 → UN ×2000 → ML.

12 CAIXA Coca 2L → **288.000 ML**. 10 FARDO água 350 ml → **42.000 ML**.

Caminho via BFS. Ciclo nas relações do usuário: `CONVERSAO_CICLO`. Sem caminho: `CONVERSAO_NAO_DISPONIVEL`.

---

## Precisão

Etapas em IEEE float. Arredondamento só na saída (`1e9`). Ficha ainda aplica `round3` no débito (contrato 03.04).

---

## Conversão inversa

SI e relações: fator inverso 1/F. 288.000 ML → 1 CAIXA com as mesmas relações.

---

## Compras

`POST /api/compras` já creditava `resultadoMuc.quantidadeEstoque`. O pipeline agora produz essa quantidade pelo MUC-02. Sem `empresa_id` no motor.

Cadastro de 1 UN = 2000 ML: apresentações (CX→UN e UN→ML) ou `relacoes` no item. **Tela “utiliza conversão” = MUC-03.**

---

## Ficha

`FichaTecnicaConsumoService` chama `obterMuc(db).converterQuantidade`. Snapshot inalterado (`quantidade`, `unidade`, `quantidade_ficha`, `unidade_ficha`). Estorno 03.07/03.08 não reconverte.

---

## Estoque

Consumidor (compras / débito de venda) aplica o número. Não existe `estoque_muc`.

---

## Multiempresa

Mesma definição de conversão. Empresa A 12 CX = 288.000 ML no estoque A; B 6 CX = 144.000 ML no estoque B.

---

## Legado

| Módulo | Status |
|--------|--------|
| `MotorUnidadesMedida.converterQuantidadeEntreUnidades` | **DEPRECADO** — delega ao MUC. Formação de preço e normalização de UC no cadastro **ainda usam** MotorUM. |
| `lib/motorConversaoUnidades.js` | **DEPRECADO** como autoridade. Ainda: custo, subtotal, rateio F/NF no pipeline. |
| Importação inicial `fator_conversao` | **Ainda próprio** — não migrado (não quebrar importações). |

Novos módulos não devem criar conversor paralelo.

---

## Cadastro (futuro MUC-03)

O modelo já aceita: produto.unidade (estoque), apresentações (tipo + quantidade + unidade), relações explícitas. Sem tela nova nesta sprint.

---

## Pastel Especial

Fora de escopo. O MUC converte cada linha (g/ml/UN). Regra 6 de 42 é sprint própria.

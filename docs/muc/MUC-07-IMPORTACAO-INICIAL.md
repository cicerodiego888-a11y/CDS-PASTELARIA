# MUC-07 — Importação inicial de produtos

**Status:** CONCLUÍDA  
**Autoridade:** `obterMuc(db).converterQuantidade` quando origem e destino forem explícitos.  
**Compatibilidade:** `fator_conversao` quando não houver unidades suficientes.

---

## 1. Fluxo anterior

`calcularEstoqueInicial` = `quantidade_documento × fator_conversao` (fator default 1). Sem MUC.

---

## 2. Fluxo novo

```
Arquivo
  ├─ origem + destino conhecidos e caminho MUC?  → converterQuantidade
  ├─ caminho MUC ausente + fator válido?         → fator (motivo CAMINHO_MUC_NAO_ENCONTRADO)
  └─ sem unidades + fator (ou default 1)         → fator (COMPATIBILIDADE)
```

Orquestrador: `calcularEstoqueInicial` → `resolverEstoqueInicialImportacao`.

---

## 3. Regra MUC

Usa MUC somente se o arquivo (ou o cadastro já existente) informar **unidade origem e unidade destino** reconhecidas. Relações vêm de apresentações do arquivo/cadastro e/ou `muc_produto_relacoes`. **Não** cria relação a partir do fator.

---

## 4. Regra legado

Sem origem/destino suficientes: `qtd × fator`. Fator omitido = 1 (contrato V1.0.x). `fator_conversao` permanece no XLSX.

---

## 5. Prioridade

MUC > fator. Se o MUC devolver quantidade, o fator **não** multiplica de novo.

---

## 6. Fallback permitido

| Situação | Ação |
|----------|------|
| Unidades ausentes/não reconhecidas | Fator (motivo `UNIDADE_NAO_INFORMADA` ou `FATOR_CONVERSAO`) |
| `CONVERSAO_NAO_DISPONIVEL` + fator válido | Fator (motivo `CAMINHO_MUC_NAO_ENCONTRADO`) |
| `CONVERSAO_INVALIDA` / `CONVERSAO_CICLO` / erro interno | Propaga. Sem fator. |
| Quantidade inválida | `QUANTIDADE_INVALIDA` |

---

## 7. Erros

Não há `try { MUC } catch { qtd * fator }` genérico. Cada código tem política explícita.

---

## 8. Multiempresa

Importação continua usando `empresaId` do contexto em `registrarEstoqueInicial` / updater. Sem fallback para empresa 1. Configuração MUC é do **produto** (catálogo compartilhado).

---

## 9. Exemplos

| Caso | Resultado | Origem |
|------|-----------|--------|
| 10 × fator 12, sem unidades | 120 | FATOR_CONVERSAO |
| 10 CAIXA, 1 CX=12 UN, dest UN, fator 99 | 120 UN | MUC |
| 300 ML → L, fator 1000 | 0,3 L | MUC |
| 10 FARDO → ML (12 UN × 350 ML) | 42.000 ML | MUC |
| 10 CAIXA → ML sem relação, fator 12 | 120 | FATOR (caminho ausente) |
| 1 KG → L, fator 1000 | erro CONVERSAO_INVALIDA | — |

---

## 10. Testes

`tests/muc/muc-07-importacao-inicial.test.js` (T01–T10). Testes V1.0.x de `calcularEstoqueInicial` sem unidades permanecem.

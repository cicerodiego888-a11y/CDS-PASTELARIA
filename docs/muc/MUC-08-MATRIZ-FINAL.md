# MUC-08 — Matriz final

Classificações: **A** = conversão MUC · **B** = responsabilidade legítima · **C** = removido · **D** = compatibilidade/depreciação

| Componente | Função | Consumidor | Responsabilidade | Classificação | Ação | Resultado |
|------------|--------|------------|------------------|---------------|------|-----------|
| MUC | `converterQuantidade` | Compra, preview, ficha, consumo, importação, cadastro | Conversão de quantidade | A | Manter | Autoridade |
| MUC | `processarItemCompra` / pipeline `converter` | Persistência compra | Estoque + DTO | A | Manter | Autoridade |
| MUC | `simular` (com unidades) | Interno | Encadeamento | A | Manter | Autoridade |
| MUC | `simular` (sem unidades) | Contrato RC2.1 | Multiplicador + custo | D | Depreciar quantidade | Preservado |
| Preview compra | `simularConversaoCompraPreview` | `POST /simular-conversao-muc` | Preview = MUC | A | Manter | MUC |
| Importação | `resolverEstoqueInicialImportacao` | helpers/validator/updater | MUC ou fator | A / D | Manter | MUC > fator |
| Ficha | `converterQuantidadeFicha` | Cadastro/consumo | Quantidade insumo | A | Manter | MUC |
| Consumo venda | `FichaTecnicaConsumoService` | Pagamento venda | Débito insumo | A | Manter | MUC |
| Cancelamento | snapshot `venda_ficha_consumo` | Estorno | Não reconverte | B | Manter | Snapshot |
| Devolução | snapshot | Estorno | Não reconverte | B | Manter | Snapshot |
| MotorUM | UC / XML / preço | Cadastro, XML | Catálogo e preço | B | Manter | Preservado |
| MotorUM | `converterQuantidadeEntreUnidades` | Só testes (pré MUC-08) | Wrapper SI | C | Remover | Removido |
| MotorUM | `FATOR_UNIDADE_BASE` | Nenhum | SI morto | C | Remover | Removido |
| MotorUM | `listarUnidadesComerciais` | Nenhum | Catálogo morto | C | Remover | Removido |
| MotorUM | `exigeQuantidadePorEmbalagem` | Formação de preço | Flag UC | B interno / C export | Export removido | Interno |
| motorConversaoUnidades | `obterQuantidadeConvertida` | Custo, F/NF, UI, testes | Leitura / fallback item | D | Depreciar | Preservado |
| motorConversaoUnidades | `simularConversaoEmbalagem` | `muc.simular` | Custo simulação | D | Depreciar | Preservado |
| Frontend | `motor-quantidade-compra.js` | compras.js | Lê `quantidade_convertida` | B | Manter | Sem conversor |
| Importação legado | `fator_conversao` | Arquivos antigos | Compatibilidade | D | Manter | Preservado |
| Equipamento | Toledo `payload/1000` | Etiqueta | Protocolo | B | Manter | Fora do MUC |
| Fiscal | `unidadeFiscal` / uCom | NF-e | Código fiscal | B | Manter | Fora do MUC |

## Matriz de fluxos (esperado)

| Fluxo | Conversor | Autoridade | Situação |
|-------|-----------|------------|----------|
| Compra persistida | MUC | MUC | OK |
| Preview compra | MUC | MUC | OK |
| Pré-fill | não pré-preenche qty | MUC na persistência | OK |
| Ficha | MUC | MUC | OK |
| Consumo | MUC | MUC | OK |
| Importação | MUC / fator legado | MUC se unidades | OK |
| Cancelamento | Snapshot | Snapshot | OK |
| Devolução | Snapshot | Snapshot | OK |
| Preço | MotorUM / legado | Preço | OK |
| F/NF | Legado (qtd já convertida) | F/NF | OK |
| Fiscal uCom | Motor fiscal | Fiscal | OK |
| Protocolo balança | Driver/parser | Protocolo | OK |

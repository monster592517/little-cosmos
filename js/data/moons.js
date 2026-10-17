/**
 * 太阳系卫星总表
 *
 *  数据口径：半径 / 半长轴 / 偏心率 / 轨道倾角 / 公转周期取自 JPL Solar System Dynamics
 *  与 IAU 命名表（**卫星计数与轨道根数口径：2026 年 8 月，NASA/MPC**；
 *  solar-system.js 各行星的 `moons:` 字段即该日期口径：木星 115 / 土星 293 /
 *  天王星 29 / 海王星 16 / 冥王星 5）。卫星轨道以母星赤道面为基准，倾角为相对母星赤道的值。
 *
 *  本表按「行星 → 卫星」组织，供目录树与三维场景共用。
 *  **建模口径（2026-10-17 补记，避免后来者误判"漏了卫星"）**：
 *    已知卫星总数（2026-08 口径，含矮行星系统）≈ 461 颗，
 *    本表**有意只建模 156 颗**——筛选依据是半径与视觉显著性：
 *    2–5 km 级的新发现小卫星在场景中不足 1 像素，逐个建模只增加开销、不增加信息。
 *    未命名的小卫星不逐个列出，由目录中的分组节点给出总数。
 *  ⚠️ 若将来要补全：加行即可（TABLE 格式一行一颗），但需同步更新各行星 `moons:`
 *    字段的统计日期注释，二者口径必须同日。
 */

/* id, 中文名, English, 母天体, 半径 km, 半长轴 km, e, 倾角°, 周期 天, 颜色, 分组 */
const TABLE = [
  /* ---------------- 地球 ---------------- */
  ['moon', '月球', 'Moon', 'earth', 1737.4, 384400, 0.0549, 5.145, 27.321661, '#686157', 'major'],

  /* ---------------- 火星 ---------------- */
  ['phobos', '火卫一 · 福波斯', 'Phobos', 'mars', 11.267, 9376, 0.0151, 1.075, 0.318910, '#8a8178', 'major'],
  ['deimos', '火卫二 · 得摩斯', 'Deimos', 'mars', 6.2, 23463, 0.00033, 1.788, 1.263, '#8f867c', 'major'],

  /* ---------------- 木星 ---------------- */
  ['metis', '木卫十六 · 墨提斯', 'Metis', 'jupiter', 21.5, 128000, 0.0002, 0.06, 0.294780, '#8a7a70', 'inner'],
  ['adrastea', '木卫十五 · 阿德剌斯忒亚', 'Adrastea', 'jupiter', 8.2, 129000, 0.0015, 0.03, 0.298260, '#8a7a70', 'inner'],
  ['amalthea', '木卫五 · 阿马尔忒亚', 'Amalthea', 'jupiter', 83.5, 181365, 0.0032, 0.374, 0.498179, '#b06a5a', 'inner'],
  ['thebe', '木卫十四 · 忒拜', 'Thebe', 'jupiter', 49.3, 221889, 0.0175, 1.076, 0.674536, '#a06a58', 'inner'],
  ['io', '木卫一 · 艾奥', 'Io', 'jupiter', 1821.6, 421800, 0.0041, 0.036, 1.769138, '#e7d3a4', 'galilean'],
  ['europa', '木卫二 · 欧罗巴', 'Europa', 'jupiter', 1560.8, 671100, 0.0094, 0.466, 3.551181, '#d6d7d4', 'galilean'],
  ['ganymede', '木卫三 · 盖尼米德', 'Ganymede', 'jupiter', 2634.1, 1070400, 0.0013, 0.177, 7.154553, '#b0b1ae', 'galilean'],
  ['callisto', '木卫四 · 卡利斯托', 'Callisto', 'jupiter', 2410.3, 1882700, 0.0074, 0.192, 16.689018, '#868683', 'galilean'],
  ['themisto', '木卫十八 · 忒弥斯托', 'Themisto', 'jupiter', 4, 7393216, 0.242, 45.7, 129.87, '#433f3b', 'irregular'],
  ['leda', '木卫十三 · 勒达', 'Leda', 'jupiter', 10, 11160000, 0.164, 27.5, 240.9, '#383838', 'irregular'],
  ['himalia', '木卫六 · 希马利亚', 'Himalia', 'jupiter', 85, 11461000, 0.162, 27.5, 250.56, '#444444', 'irregular'],
  ['ersa', '木卫七十一 · 厄耳萨', 'Ersa', 'jupiter', 1.5, 11483000, 0.094, 30.6, 250.4, '#444445', 'irregular'],
  ['pandia', '木卫六十五 · 潘狄亚', 'Pandia', 'jupiter', 1.5, 11525000, 0.18, 28.15, 252.1, '#3f3f3f', 'irregular'],
  ['lysithea', '木卫十 · 吕西忒亚', 'Lysithea', 'jupiter', 18, 11717000, 0.112, 28.3, 259.2, '#4b4c4c', 'irregular'],
  ['elara', '木卫七 · 厄拉拉', 'Elara', 'jupiter', 43, 11741000, 0.217, 26.6, 259.6, '#444444', 'irregular'],
  ['dia', '木卫五十三 · 狄亚', 'Dia', 'jupiter', 2, 12260000, 0.21, 28.2, 287.0, '#3e3e3f', 'irregular'],
  ['carpo', '木卫四十六 · 卡尔波', 'Carpo', 'jupiter', 1.5, 17058000, 0.43, 51.4, 456.1, '#373532', 'irregular'],
  ['euporie', '木卫三十四 · 欧波里厄', 'Euporie', 'jupiter', 1, 19304000, 0.14, 145.7, 550.7, '#2f2e2c', 'irregular'],
  ['eupheme', '木卫六十 · 欧斐墨', 'Eupheme', 'jupiter', 1, 19622000, 0.25, 146.0, 561.5, '#44423f', 'irregular'],
  ['orthosie', '木卫三十五 · 俄耳托西厄', 'Orthosie', 'jupiter', 1, 20721000, 0.28, 145.9, 622.6, '#3b3937', 'irregular'],
  ['euanthe', '木卫三十三 · 欧安忒', 'Euanthe', 'jupiter', 1.5, 20799000, 0.23, 148.9, 620.6, '#363432', 'irregular'],
  ['helike', '木卫四十五 · 赫利刻', 'Helike', 'jupiter', 2, 20915000, 0.15, 154.8, 626.3, '#2c2a29', 'irregular'],
  ['praxidike', '木卫二十七 · 普拉克西狄刻', 'Praxidike', 'jupiter', 3.5, 20908000, 0.23, 149.0, 625.3, '#353331', 'irregular'],
  ['thyone', '木卫二十九 · 提俄涅', 'Thyone', 'jupiter', 2, 20939000, 0.23, 148.5, 627.3, '#373534', 'irregular'],
  ['ananke', '木卫十二 · 阿南刻', 'Ananke', 'jupiter', 14, 21276000, 0.24, 148.9, 629.8, '#312f2d', 'irregular'],
  ['iocaste', '木卫二十四 · 伊俄卡斯忒', 'Iocaste', 'jupiter', 2.6, 21066000, 0.22, 149.4, 631.5, '#343230', 'irregular'],
  ['harpalyke', '木卫二十二 · 哈耳帕吕刻', 'Harpalyke', 'jupiter', 2.2, 22124000, 0.23, 148.6, 634.9, '#3c3a38', 'irregular'],
  ['aitne', '木卫三十一 · 埃特涅', 'Aitne', 'jupiter', 1.5, 22285000, 0.26, 165.1, 712.0, '#3b3936', 'irregular'],
  ['kale', '木卫三十七 · 卡勒', 'Kale', 'jupiter', 1, 22409000, 0.26, 165.0, 736.0, '#3e3c39', 'irregular'],
  ['taygete', '木卫二十 · 塔宇革忒', 'Taygete', 'jupiter', 2.5, 22439000, 0.25, 165.2, 732.4, '#373431', 'irregular'],
  ['chaldene', '木卫二十一 · 卡尔得涅', 'Chaldene', 'jupiter', 1.9, 22713000, 0.25, 165.2, 759.9, '#383633', 'irregular'],
  ['kalyke', '木卫二十三 · 卡吕刻', 'Kalyke', 'jupiter', 2.6, 23181000, 0.25, 165.2, 766.0, '#3d3430', 'irregular'],
  ['erinome', '木卫二十五 · 厄里诺墨', 'Erinome', 'jupiter', 1.6, 22986000, 0.27, 164.4, 711.9, '#33312e', 'irregular'],
  ['isonoe', '木卫二十六 · 伊索诺厄', 'Isonoe', 'jupiter', 1.9, 23155000, 0.25, 165.2, 726.3, '#393633', 'irregular'],
  ['autonoe', '木卫二十八 · 奥托诺厄', 'Autonoe', 'jupiter', 2, 23039000, 0.32, 152.9, 772.2, '#2f2e2c', 'irregular'],
  ['megaclite', '木卫十九 · 墨伽克利忒', 'Megaclite', 'jupiter', 2.7, 23493000, 0.42, 152.8, 782.4, '#363533', 'irregular'],
  ['sponde', '木卫三十六 · 斯蓬得', 'Sponde', 'jupiter', 1, 23487000, 0.31, 151.0, 771.6, '#3a3938', 'irregular'],
  ['pasiphae', '木卫八 · 帕西法厄', 'Pasiphae', 'jupiter', 30, 23624000, 0.41, 151.4, 764.1, '#42413f', 'irregular'],
  ['hegemone', '木卫三十九 · 赫革摩涅', 'Hegemone', 'jupiter', 1.5, 23947000, 0.36, 155.2, 739.6, '#353432', 'irregular'],
  ['cyllene', '木卫四十八 · 库勒涅', 'Cyllene', 'jupiter', 1, 23951000, 0.41, 145.0, 752.0, '#333230', 'irregular'],
  ['sinope', '木卫九 · 西诺珀', 'Sinope', 'jupiter', 19, 24094000, 0.25, 158.1, 758.9, '#413e3a', 'irregular'],
  ['aoede', '木卫四十一 · 阿俄得', 'Aoede', 'jupiter', 2, 23044000, 0.43, 158.7, 714.7, '#41403f', 'irregular'],
  ['callirrhoe', '木卫十七 · 卡利罗厄', 'Callirrhoe', 'jupiter', 4.3, 24103000, 0.28, 147.1, 758.8, '#363534', 'irregular'],
  ['eurydome', '木卫三十二 · 欧里多墨', 'Eurydome', 'jupiter', 1.5, 22865000, 0.28, 150.3, 717.3, '#2e2c2b', 'irregular'],
  ['kore', '木卫四十九 · 科瑞', 'Kore', 'jupiter', 1, 24011000, 0.33, 145.0, 776.0, '#302f2e', 'irregular'],
  ['eirene', '木卫五十七 · 厄瑞涅', 'Eirene', 'jupiter', 2, 23174000, 0.22, 163.6, 759.7, '#3a3835', 'irregular'],
  ['philophrosyne', '木卫五十八 · 菲洛佛洛绪涅', 'Philophrosyne', 'jupiter', 1, 22605000, 0.19, 146.3, 702.2, '#302f2d', 'irregular'],

  /* ---------------- 土星 ---------------- */
  ['pan', '土卫十八 · 潘', 'Pan', 'saturn', 14.1, 133584, 0.0000145, 0.0, 0.57505, '#c9c4b4', 'ring'],
  ['daphnis', '土卫三十五 · 达佛涅斯', 'Daphnis', 'saturn', 3.8, 136505, 0.0000331, 0.0036, 0.59408, '#c9c4b4', 'ring'],
  ['atlas', '土卫十五 · 阿特拉斯', 'Atlas', 'saturn', 15.1, 137670, 0.0012, 0.003, 0.60169, '#c9c4b4', 'ring'],
  ['prometheus', '土卫十六 · 普罗米修斯', 'Prometheus', 'saturn', 43.1, 139380, 0.0022, 0.008, 0.61299, '#c9c4b4', 'ring'],
  ['pandora', '土卫十七 · 潘多拉', 'Pandora', 'saturn', 40.7, 141720, 0.0042, 0.05, 0.62850, '#c9c4b4', 'ring'],
  ['epimetheus', '土卫十一 · 厄庇墨透斯', 'Epimetheus', 'saturn', 58.1, 151410, 0.0098, 0.351, 0.69433, '#bdb8a8', 'inner'],
  ['janus', '土卫十 · 雅努斯', 'Janus', 'saturn', 89.5, 151460, 0.0068, 0.163, 0.69459, '#c2bdad', 'inner'],
  ['aegaeon', '土卫五十三 · 埃该翁', 'Aegaeon', 'saturn', 0.33, 167500, 0.0002, 0.001, 0.80812, '#b8b3a4', 'ring'],
  ['mimas', '土卫一 · 弥玛斯', 'Mimas', 'saturn', 198.2, 185539, 0.0196, 1.574, 0.942422, '#d5d8db', 'major'],
  ['methone', '土卫三十二 · 墨托涅', 'Methone', 'saturn', 1.6, 194440, 0.0001, 0.007, 1.00957, '#d5d8db', 'ring'],
  ['anthe', '土卫四十九 · 安忒', 'Anthe', 'saturn', 1, 197700, 0.001, 0.02, 1.05089, '#d5d8db', 'ring'],
  ['pallene', '土卫三十三 · 帕勒涅', 'Pallene', 'saturn', 2.5, 212280, 0.004, 0.181, 1.15375, '#d5d8db', 'ring'],
  ['enceladus', '土卫二 · 恩克拉多斯', 'Enceladus', 'saturn', 252.1, 237948, 0.0047, 0.009, 1.370218, '#feffff', 'major'],
  ['tethys', '土卫三 · 忒堤斯', 'Tethys', 'saturn', 531.1, 294619, 0.0001, 1.091, 1.887802, '#e2e6e8', 'major'],
  ['telesto', '土卫十三 · 忒勒斯托', 'Telesto', 'saturn', 12.4, 294619, 0.0002, 1.18, 1.887802, '#d8d8d0', 'trojan'],
  ['calypso', '土卫十四 · 卡吕普索', 'Calypso', 'saturn', 10.7, 294619, 0.0005, 1.5, 1.887802, '#d8d8d0', 'trojan'],
  ['dione', '土卫四 · 狄俄涅', 'Dione', 'saturn', 561.4, 377396, 0.0022, 0.019, 2.736915, '#d8d8d4', 'major'],
  ['helene', '土卫十二 · 海伦', 'Helene', 'saturn', 17.6, 377396, 0.0071, 0.213, 2.736915, '#d4d4cc', 'trojan'],
  ['polydeuces', '土卫三十四 · 波吕丢刻斯', 'Polydeuces', 'saturn', 1.3, 377396, 0.0192, 0.177, 2.736915, '#d4d4cc', 'trojan'],
  ['rhea', '土卫五 · 瑞亚', 'Rhea', 'saturn', 763.8, 527108, 0.0010, 0.345, 4.518212, '#d0cec8', 'major'],
  ['titan', '土卫六 · 泰坦', 'Titan', 'saturn', 2574.7, 1221870, 0.0288, 0.348, 15.945, '#908678', 'major'],
  ['hyperion', '土卫七 · 许珀里翁', 'Hyperion', 'saturn', 135, 1481009, 0.1230, 0.43, 21.2766, '#b8a888', 'major'],
  ['iapetus', '土卫八 · 伊阿珀托斯', 'Iapetus', 'saturn', 734.5, 3560820, 0.0283, 15.47, 79.3215, '#8e8578', 'major'],
  ['kiviuq', '土卫二十四 · 基维乌克', 'Kiviuq', 'saturn', 8, 11111000, 0.334, 45.7, 449.22, '#33302c', 'irregular'],
  ['ijiraq', '土卫二十二 · 伊吉拉克', 'Ijiraq', 'saturn', 6, 11124000, 0.316, 46.4, 451.42, '#35322e', 'irregular'],
  ['paaliaq', '土卫二十 · 帕利亚克', 'Paaliaq', 'saturn', 11, 15200000, 0.364, 45.1, 686.95, '#3b3834', 'irregular'],
  ['albiorix', '土卫二十六 · 阿尔比奥里克斯', 'Albiorix', 'saturn', 14.3, 16182000, 0.477, 34.2, 783.45, '#3b3632', 'irregular'],
  ['bebhionn', '土卫三十七 · 贝芙温', 'Bebhionn', 'saturn', 3, 17028000, 0.469, 35.0, 834.84, '#37332f', 'irregular'],
  ['erriapus', '土卫二十八 · 厄里阿波斯', 'Erriapus', 'saturn', 5, 17343000, 0.474, 34.6, 871.14, '#2f2c28', 'irregular'],
  ['skathi', '土卫二十七 · 斯卡蒂', 'Skathi', 'saturn', 4, 15576000, 0.270, 152.6, 728.10, '#34312e', 'irregular'],
  ['siarnaq', '土卫二十九 · 西亚尔纳克', 'Siarnaq', 'saturn', 20, 18015000, 0.295, 46.0, 895.52, '#34312d', 'irregular'],
  ['tarqeq', '土卫五十二 · 塔尔克克', 'Tarqeq', 'saturn', 3.5, 18009000, 0.160, 46.1, 887.48, '#3e3a36', 'irregular'],
  ['hyrrokkin', '土卫四十四 · 许罗金', 'Hyrrokkin', 'saturn', 4, 18437000, 0.334, 151.4, 931.86, '#302d2a', 'irregular'],
  ['greip', '土卫五十一 · 格雷普', 'Greip', 'saturn', 3, 18206000, 0.318, 172.7, 921.19, '#43403d', 'irregular'],
  ['jarnsaxa', '土卫五十 · 亚尔恩萨萨', 'Jarnsaxa', 'saturn', 3, 19357000, 0.217, 163.0, 964.74, '#403d39', 'irregular'],
  ['tarvos', '土卫二十一 · 塔尔沃斯', 'Tarvos', 'saturn', 7.5, 18247000, 0.528, 34.7, 926.37, '#3d3934', 'irregular'],
  ['mundilfari', '土卫二十五 · 蒙迪尔法里', 'Mundilfari', 'saturn', 3.5, 18632000, 0.210, 169.4, 951.56, '#35322f', 'irregular'],
  ['narvi', '土卫三十一 · 纳尔维', 'Narvi', 'saturn', 3.5, 19007000, 0.299, 145.8, 1003.9, '#312f2c', 'irregular'],
  ['bergelmir', '土卫三十八 · 贝格尔米尔', 'Bergelmir', 'saturn', 3, 19338000, 0.144, 158.6, 1005.9, '#46433f', 'irregular'],
  ['suttungr', '土卫二十三 · 苏图恩格尔', 'Suttungr', 'saturn', 3.5, 19467000, 0.113, 174.3, 1016.7, '#373531', 'irregular'],
  ['hati', '土卫四十三 · 哈提', 'Hati', 'saturn', 3, 19697000, 0.375, 164.4, 1038.7, '#2d2a28', 'irregular'],
  ['farbauti', '土卫四十 · 法尔鲍蒂', 'Farbauti', 'saturn', 2.5, 19984000, 0.249, 156.4, 1054.4, '#46423f', 'irregular'],
  ['thrymr', '土卫三十 · 苏里姆', 'Thrymr', 'saturn', 3.5, 20278000, 0.470, 174.0, 1078.6, '#32302d', 'irregular'],
  ['aegir', '土卫三十六 · 埃吉尔', 'Aegir', 'saturn', 3, 20482000, 0.252, 166.7, 1094.0, '#34312f', 'irregular'],
  ['bestla', '土卫三十九 · 贝斯特拉', 'Bestla', 'saturn', 3.5, 20129000, 0.521, 145.2, 1083.6, '#3d3a37', 'irregular'],
  ['fenrir', '土卫四十一 · 芬里尔', 'Fenrir', 'saturn', 2, 22453000, 0.131, 164.3, 1260.4, '#43403c', 'irregular'],
  ['surtur', '土卫四十八 · 苏尔特', 'Surtur', 'saturn', 3, 22707000, 0.451, 177.5, 1297.4, '#3a3734', 'irregular'],
  ['loge', '土卫四十六 · 洛格', 'Loge', 'saturn', 3, 23065000, 0.187, 167.9, 1312.0, '#474340', 'irregular'],
  ['ymir', '土卫十九 · 尤弥尔', 'Ymir', 'saturn', 9, 23040000, 0.335, 173.1, 1315.1, '#403d39', 'irregular'],
  ['fornjot', '土卫四十二 · 福尔恩约特', 'Fornjot', 'saturn', 3, 25108000, 0.206, 170.4, 1490.9, '#383633', 'irregular'],
  ['phoebe', '土卫九 · 福柏', 'Phoebe', 'saturn', 106.5, 12947900, 0.1634, 175.2, 550.31, '#4c4d4d', 'irregular'],

  /* ---------------- 天王星 ---------------- */
  ['cordelia', '天卫六 · 科迪莉亚', 'Cordelia', 'uranus', 20.1, 49751, 0.00026, 0.085, 0.335034, '#9aa0a4', 'inner'],
  ['ophelia', '天卫七 · 奥菲莉亚', 'Ophelia', 'uranus', 21.4, 53764, 0.00992, 0.104, 0.376400, '#9aa0a4', 'inner'],
  ['bianca', '天卫八 · 比安卡', 'Bianca', 'uranus', 25.7, 59165, 0.00092, 0.193, 0.434579, '#9aa0a4', 'inner'],
  ['cressida', '天卫九 · 克瑞西达', 'Cressida', 'uranus', 39.8, 61767, 0.00036, 0.006, 0.463570, '#9aa0a4', 'inner'],
  ['desdemona', '天卫十 · 苔丝狄蒙娜', 'Desdemona', 'uranus', 32, 62658, 0.00013, 0.111, 0.473650, '#9aa0a4', 'inner'],
  ['juliet', '天卫十一 · 朱丽叶', 'Juliet', 'uranus', 46.8, 64358, 0.00066, 0.065, 0.493065, '#9aa0a4', 'inner'],
  ['portia', '天卫十二 · 波西娅', 'Portia', 'uranus', 67.6, 66101, 0.00005, 0.059, 0.513196, '#9aa0a4', 'inner'],
  ['rosalind', '天卫十三 · 罗瑟琳', 'Rosalind', 'uranus', 36, 69927, 0.00011, 0.279, 0.558442, '#9aa0a4', 'inner'],
  ['belinda', '天卫十四 · 贝琳达', 'Belinda', 'uranus', 40.3, 75256, 0.00007, 0.031, 0.623527, '#9aa0a4', 'inner'],
  ['perdita', '天卫二十五 · 珀狄塔', 'Perdita', 'uranus', 13, 76417, 0.0012, 0.07, 0.638, '#9aa0a4', 'inner'],
  ['puck', '天卫十五 · 帕克', 'Puck', 'uranus', 81, 86004, 0.00012, 0.319, 0.761833, '#a0a6aa', 'inner'],
  ['mab', '天卫二十六 · 玛布', 'Mab', 'uranus', 12.5, 97736, 0.0025, 0.133, 0.923, '#9aa0a4', 'inner'],
  ['cupid', '天卫二十七 · 丘比特', 'Cupid', 'uranus', 9, 74392, 0.0013, 0.099, 0.618, '#9aa0a4', 'inner'],
  ['miranda', '天卫五 · 米兰达', 'Miranda', 'uranus', 235.8, 129390, 0.0013, 4.338, 1.413479, '#c8c8c4', 'major'],
  ['ariel', '天卫一 · 艾瑞尔', 'Ariel', 'uranus', 578.9, 190900, 0.0012, 0.041, 2.520379, '#d4d6d8', 'major'],
  ['umbriel', '天卫二 · 乌姆柏里厄尔', 'Umbriel', 'uranus', 584.7, 266000, 0.0039, 0.128, 4.144177, '#9a9a98', 'major'],
  ['titania', '天卫三 · 泰坦妮亚', 'Titania', 'uranus', 788.4, 435910, 0.0011, 0.079, 8.705872, '#c0bcb4', 'major'],
  ['oberon', '天卫四 · 奥伯龙', 'Oberon', 'uranus', 761.4, 583520, 0.0014, 0.068, 13.463239, '#a8a49c', 'major'],
  ['francisco', '天卫二十二 · 弗朗西斯科', 'Francisco', 'uranus', 11, 4276000, 0.146, 145.2, 266.56, '#3a3835', 'irregular'],
  ['caliban', '天卫十六 · 卡利班', 'Caliban', 'uranus', 36, 7231000, 0.159, 139.9, 579.73, '#3d3a37', 'irregular'],
  ['stephano', '天卫二十 · 斯忒法诺', 'Stephano', 'uranus', 16, 8004000, 0.229, 144.1, 677.37, '#363330', 'irregular'],
  ['trinculo', '天卫二十一 · 特林库洛', 'Trinculo', 'uranus', 9, 8504000, 0.220, 167.1, 749.24, '#43403d', 'irregular'],
  ['sycorax', '天卫十七 · 西科拉克斯', 'Sycorax', 'uranus', 75, 12179000, 0.522, 159.4, 1288.3, '#363431', 'irregular'],
  ['margaret', '天卫二十三 · 玛格丽特', 'Margaret', 'uranus', 10, 14345000, 0.661, 56.6, 1687.0, '#43403d', 'irregular'],
  ['prospero', '天卫十八 · 普洛斯彼罗', 'Prospero', 'uranus', 25, 16256000, 0.444, 151.8, 1978.3, '#32302d', 'irregular'],
  ['setebos', '天卫十九 · 塞特波斯', 'Setebos', 'uranus', 24, 17418000, 0.591, 158.2, 2225.1, '#403e3a', 'irregular'],
  ['ferdinand', '天卫二十四 · 斐迪南', 'Ferdinand', 'uranus', 10, 20421000, 0.368, 170.0, 2823.4, '#3b3936', 'irregular'],

  /* ---------------- 海王星 ---------------- */
  ['naiad', '海卫三 · 那伊阿得', 'Naiad', 'neptune', 33, 48227, 0.00035, 4.691, 0.294396, '#8e8e8a', 'inner'],
  ['thalassa', '海卫四 · 塔拉萨', 'Thalassa', 'neptune', 41, 50074, 0.00016, 0.135, 0.311485, '#8e8e8a', 'inner'],
  ['despina', '海卫五 · 得斯波那', 'Despina', 'neptune', 75, 52526, 0.00038, 0.068, 0.334655, '#8e8e8a', 'inner'],
  ['galatea', '海卫六 · 伽拉忒亚', 'Galatea', 'neptune', 88, 61953, 0.00005, 0.034, 0.428745, '#8e8e8a', 'inner'],
  ['larissa', '海卫七 · 拉里萨', 'Larissa', 'neptune', 97, 73548, 0.00139, 0.205, 0.554654, '#8e8e8a', 'inner'],
  ['hippocamp', '海卫十四 · 希波坎普', 'Hippocamp', 'neptune', 17.4, 105283, 0.00048, 0.064, 0.9362, '#8e8e8a', 'inner'],
  ['proteus', '海卫八 · 普罗透斯', 'Proteus', 'neptune', 210, 117647, 0.00053, 0.524, 1.122315, '#8e8e8a', 'major'],
  ['triton', '海卫一 · 特里同', 'Triton', 'neptune', 1353.4, 354759, 0.000016, 156.885, -5.876854, '#d8d8d0', 'major'],
  ['nereid', '海卫二 · 涅瑞伊德', 'Nereid', 'neptune', 170, 5513400, 0.7507, 7.23, 360.13, '#3e3d3c', 'irregular'],
  ['halimede', '海卫九 · 哈利墨得', 'Halimede', 'neptune', 31, 16611000, 0.2646, 112.7, 1879.1, '#42403f', 'irregular'],
  ['sao', '海卫十一 · 萨俄', 'Sao', 'neptune', 22, 22228000, 0.2931, 48.5, 2914.0, '#393734', 'irregular'],
  ['laomedeia', '海卫十二 · 拉俄墨得亚', 'Laomedeia', 'neptune', 21, 23567000, 0.4238, 47.5, 3167.9, '#3c3a37', 'irregular'],
  ['psamathe', '海卫十 · 普萨玛忒', 'Psamathe', 'neptune', 20, 46705000, 0.4617, 126.3, 9115.9, '#3f3c3a', 'irregular'],
  ['neso', '海卫十三 · 涅索', 'Neso', 'neptune', 30, 49898000, 0.4246, 127.4, 9880.6, '#3f3d3a', 'irregular'],

  /* ---------------- 冥王星 ---------------- */
  ['charon', '冥卫一 · 卡戎', 'Charon', 'pluto', 606, 19591, 0.0002, 0.08, 6.3872, '#b8b0a8', 'major'],
  ['nix', '冥卫二 · 尼克斯', 'Nix', 'pluto', 19.5, 48694, 0.0020, 0.133, 24.856, '#a8a098', 'major'],
  ['hydra', '冥卫三 · 许德拉', 'Hydra', 'pluto', 20.5, 64738, 0.0059, 0.242, 38.202, '#a8a098', 'major'],
  ['kerberos', '冥卫四 · 刻耳柏洛斯', 'Kerberos', 'pluto', 9.5, 57783, 0.0033, 0.389, 32.168, '#a09a92', 'major'],
  ['styx', '冥卫五 · 斯堤克斯', 'Styx', 'pluto', 5, 42656, 0.0050, 0.809, 20.161, '#a09a92', 'major'],

  /* ---------------- 其他矮行星的卫星 ---------------- */
  ['dysnomia', '阋卫一 · 戴丝诺米亚', 'Dysnomia', 'eris', 350, 37273, 0.0062, 0.7, 15.774, '#c8ccd0', 'major'],
  ['hiiaka', '妊卫一 · 希亚卡', "Hi'iaka", 'haumea', 160, 49880, 0.0513, 0.2, 49.12, '#d0ccc4', 'major'],
  ['namaka', '妊卫二 · 娜玛卡', 'Namaka', 'haumea', 85, 25657, 0.249, 13.0, 18.278, '#c8c4bc', 'major'],
  ['mk2', '鸟卫一 · MK 2', 'S/2015 (136472) 1', 'makemake', 87.5, 21100, 0.0, 1.0, 12.4, '#b8a898', 'major'],
  ['xiangliu', '共卫一 · 相柳', 'Xiangliu', 'gonggong', 100, 24021, 0.29, 15.0, 25.22, '#b09080', 'major'],
  ['weywot', '创卫一 · 韦沃特', 'Weywot', 'quaoar', 85, 13300, 0.14, 14.0, 12.438, '#b8a898', 'major'],
  ['vanth', '亡卫一 · 万斯', 'Vanth', 'orcus', 221, 8980, 0.0036, 0.4, 9.539, '#a8a8a0', 'major'],
  ['actaea', '萨卫一 · 阿克泰亚', 'Actaea', 'salacia', 143, 5619, 0.0102, 0.2, 5.4939, '#98a8b0', 'major'],
  ['ilmare', '瓦卫一 · 伊尔玛瑞', "Ilmarë", 'varda', 163, 4800, 0.02, 1.0, 5.75, '#a8b0b8', 'major'],
];

/* 主要卫星的详细资料（其余由程序自动生成） */
const DETAIL = {
  moon: {
    massKg: 7.342e22, densityGcm3: 3.344, gravity: 1.62, escapeKms: 2.38, rotationHours: 655.7,
    axialTilt: 6.68, albedo: 0.136, magV: -12.74, tempK: 250, tempMinK: 100, tempMaxK: 390,
    texture: 'moon.jpg', node: 125.08, phase: 135,
    composition: ['铁核（部分液态）', '硅酸盐地幔', '厚 50–80 km 的斜长岩壳'],
    desc: '地球唯一的天然卫星，可能源自 45 亿年前一次巨大撞击。它稳定了地球的自转轴，并驱动潮汐。',
    facts: ['1969–1972 年阿波罗计划共有 12 人登月。', '2024 年嫦娥六号首次从月球背面取样返回。', '月球南极永久阴影区存在水冰，是未来基地的关键资源。', '位置由 ELP2000 月球理论实时计算，与 JPL 一致。'],
    researchQuery: 'Moon Artemis water ice',
  },
  phobos: { massKg: 1.0659e16, densityGcm3: 1.876, gravity: 0.0057, escapeKms: 0.011, shape: 'irregular', texture: 'phobos.jpg', desc: '火星较大的卫星，形状不规则，表面有巨大的斯蒂克尼坑。它正以每百年 1.8 米的速度接近火星，约 5000 万年后将解体或撞毁。', facts: ['公转周期比火星自转还快，因此在火星上看它西升东落。', '可能是被捕获的小行星，也可能是撞击溅射物重新聚集而成。'], researchQuery: 'Phobos Mars moon' },
  deimos: { massKg: 1.4762e15, densityGcm3: 1.471, gravity: 0.003, escapeKms: 0.0056, shape: 'irregular', texture: 'deimos.jpg', desc: '火星较小的卫星，表面被细密的风化层覆盖。', facts: ['1877 年与火卫一同被阿萨夫·霍尔发现。'], researchQuery: 'Deimos Mars moon' },
  io: { massKg: 8.932e22, densityGcm3: 3.528, gravity: 1.796, escapeKms: 2.56, tempK: 110, albedo: 0.63, texture: 'io.jpg', desc: '太阳系火山活动最剧烈的天体，表面有 400 多座活火山，硫磺喷流可高达 500 公里。潮汐加热是其能量来源。', facts: ['表面几乎没有撞击坑，地质年龄极年轻。', '位置由木卫专用模型计算，与 JPL 一致。', '朱诺号 2023–2024 年的近距离飞掠拍到了熔岩湖与火山羽流。'], researchQuery: 'Io volcanism tidal heating Juno' },
  europa: { massKg: 4.8e22, densityGcm3: 3.013, gravity: 1.315, escapeKms: 2.025, tempK: 102, albedo: 0.67, texture: 'europa.jpg', desc: '冰壳之下存在全球性液态海洋，水量约为地球海洋的两倍。它是太阳系最受关注的地外生命候选地。', facts: ['表面是太阳系最平滑的天体之一，布满纵横交错的冰脊。', 'Europa Clipper 已于 2024 年发射，2030 年抵达。'], researchQuery: 'Europa subsurface ocean habitability' },
  ganymede: { massKg: 1.4819e23, densityGcm3: 1.936, gravity: 1.428, escapeKms: 2.741, tempK: 110, albedo: 0.43, texture: 'ganymede.jpg', desc: '太阳系最大的卫星，比水星还大，也是唯一拥有自身磁场的卫星。', facts: ['拥有稀薄的氧气外逸层。', 'JUICE 将于 2031 年进入其环绕轨道。', '朱诺号拍到了它的极区与极光痕迹。'], researchQuery: 'Ganymede magnetic field ocean' },
  callisto: { massKg: 1.0759e23, densityGcm3: 1.834, gravity: 1.235, escapeKms: 2.44, tempK: 134, albedo: 0.22, texture: 'callisto.jpg', desc: '太阳系表面撞击坑最密集的天体，地质活动早已停止，记录着 40 亿年的撞击史。', facts: ['位于木星强辐射带之外，被视为未来载人基地候选。'], researchQuery: 'Callisto subsurface ocean' },
  titan: { massKg: 1.3452e23, densityGcm3: 1.882, gravity: 1.352, escapeKms: 2.639, tempK: 94, albedo: 0.22, texture: 'titan.jpg', atmosphere: '氮 95%、甲烷 5%，表面气压 1.45 bar', desc: '太阳系唯一拥有稠密大气的卫星（气压 1.45 bar），表面有液态甲烷湖泊与河流，是研究生命前化学的天然实验室。', facts: ['大气以氮为主，还有甲烷云与降雨。', 'NASA 蜻蜓号（Dragonfly）旋翼机将于 2028 年发射前往探测。', '惠更斯号 2005 年在此着陆，是人类首次在外太阳系天体软着陆。'], researchQuery: 'Titan methane lakes Dragonfly' },
  enceladus: { massKg: 1.08e20, densityGcm3: 1.609, gravity: 0.113, escapeKms: 0.239, tempK: 75, albedo: 0.81, texture: 'enceladus.jpg', desc: '南极虎纹裂缝喷出的水汽羽流含有盐、有机分子与氢气，指向冰下海洋中的热液活动。', facts: ['羽流直接补给土星的 E 环。', '卡西尼号曾穿越羽流并直接采样分析。'], researchQuery: 'Enceladus plume ocean habitability' },
  mimas: { massKg: 3.7493e19, densityGcm3: 1.150, gravity: 0.064, escapeKms: 0.159, tempK: 64, albedo: 0.962, texture: 'mimas.jpg', desc: '因巨大的赫歇尔撞击坑而被称为「死星卫星」。2024 年研究认为其冰壳下可能存在年轻的内部海洋。', facts: ['赫歇尔坑直径 139 公里，接近卫星半径的 1/3。'], researchQuery: 'Mimas internal ocean' },
  rhea: { massKg: 2.306e21, densityGcm3: 1.236, gravity: 0.264, escapeKms: 0.635, tempK: 76, albedo: 0.949, texture: 'rhea.jpg', desc: '土星第二大卫星，主要由水冰构成，表面古老且布满撞击坑。', facts: ['可能存在稀薄的氧气-二氧化碳外逸层。'], researchQuery: 'Rhea Saturn moon' },
  iapetus: { massKg: 1.8056e21, densityGcm3: 1.088, gravity: 0.223, escapeKms: 0.573, tempK: 110, albedo: 0.3, texture: 'iapetus.jpg', desc: '拥有奇特的「阴阳脸」：一面漆黑如炭，一面洁白如雪；赤道还有一道高达 13 公里的山脊。', facts: ['暗面物质可能来自土卫九（Phoebe）的尘埃。'], researchQuery: 'Iapetus two-tone ridge' },
  dione: { massKg: 1.0954e21, densityGcm3: 1.478, gravity: 0.232, escapeKms: 0.510, tempK: 87, albedo: 0.998, texture: 'dione.jpg', desc: '表面有明亮的冰崖网络（「维里塔斯」地貌）。', facts: ['可能拥有稀薄氧气外逸层。'], researchQuery: 'Dione Saturn moon' },
  tethys: { massKg: 6.1749e20, densityGcm3: 0.984, gravity: 0.145, escapeKms: 0.393, tempK: 86, albedo: 1.229, texture: 'tethys.jpg', desc: '几乎完全由水冰构成，密度仅 0.98 g/cm³，表面有巨大的奥德修斯坑。', facts: ['拥有横贯 2000 公里的伊萨卡峡谷。'], researchQuery: 'Tethys Saturn moon' },
  hyperion: { massKg: 5.62e18, densityGcm3: 0.544, gravity: 0.017, escapeKms: 0.048, shape: 'irregular', texture: 'hyperion.jpg', desc: '形状如海绵的多孔卫星，自转混沌，密度极低。', facts: ['是太阳系中已知自转最混乱的天体之一。'], researchQuery: 'Hyperion chaotic rotation' },
  phoebe: { massKg: 8.29e18, densityGcm3: 1.638, gravity: 0.049, escapeKms: 0.1, shape: 'irregular', texture: 'phoebe.jpg', desc: '逆行公转的暗色卫星，很可能是被捕获的柯伊伯带天体。', facts: ['土卫八的暗面物质被认为来自它。'], researchQuery: 'Phoebe captured Kuiper belt' },
  miranda: { massKg: 6.59e19, densityGcm3: 1.2, gravity: 0.079, escapeKms: 0.193, tempK: 60, albedo: 0.32, texture: 'miranda.jpg', desc: '表面地貌极端破碎，有高达 20 公里的悬崖（维罗纳断崖），被称为「弗兰肯斯坦卫星」。', facts: ['地貌可能由过去的潮汐加热与重聚事件造成。'], researchQuery: 'Miranda Verona Rupes' },
  ariel: { massKg: 1.353e21, densityGcm3: 1.592, gravity: 0.27, escapeKms: 0.559, tempK: 58, albedo: 0.39, texture: 'ariel.jpg', desc: '天王星卫星中最亮、表面最年轻的一颗，有大量峡谷与疑似冰火山流。', facts: ['可能是天王星系中地质活动最活跃的卫星。'], researchQuery: 'Ariel Uranus moon' },
  umbriel: { massKg: 1.172e21, densityGcm3: 1.4, gravity: 0.23, escapeKms: 0.52, tempK: 61, albedo: 0.21, texture: 'umbriel.jpg', desc: '天王星系中最暗的卫星，表面古老，有一个明亮的「荧光环」。', facts: ['暗面可能覆盖着辐射处理过的有机物质。'], researchQuery: 'Umbriel Uranus moon' },
  titania: { massKg: 3.527e21, densityGcm3: 1.711, gravity: 0.379, escapeKms: 0.773, tempK: 60, albedo: 0.27, texture: 'titania.jpg', desc: '天王星最大的卫星，表面有巨大的峡谷系统。', facts: ['以莎士比亚《仲夏夜之梦》中的仙后命名。'], researchQuery: 'Titania Uranus moon' },
  oberon: { massKg: 3.014e21, densityGcm3: 1.63, gravity: 0.347, escapeKms: 0.726, tempK: 60, albedo: 0.23, texture: 'oberon.jpg', desc: '天王星最外侧的大卫星，表面布满暗色坑底物质。', facts: ['有高达 11 公里的山峰。'], researchQuery: 'Oberon Uranus moon' },
  puck: { texture: 'puck.jpg', desc: '天王星内侧最大的小卫星，1985 年由旅行者 2 号发现，表面布满撞击坑。', facts: ['名字来自莎士比亚《仲夏夜之梦》中的精灵帕克。'], researchQuery: 'Puck Uranus moon' },
  triton: { massKg: 2.139e22, densityGcm3: 2.061, gravity: 0.779, escapeKms: 1.455, tempK: 38, albedo: 0.76, texture: 'triton.jpg', desc: '太阳系唯一大型逆行卫星，几乎可以确定是被捕获的柯伊伯带天体。表面温度仅 38 K，却有氮气冰火山在喷发。', facts: ['表面年龄极轻，存在「哈密瓜皮」地形。', '潮汐演化正使它缓慢靠近海王星。'], researchQuery: 'Triton cryovolcanism captured' },
  proteus: { massKg: 4.4e19, densityGcm3: 1.3, gravity: 0.07, escapeKms: 0.17, shape: 'irregular', desc: '形状不规则的暗色卫星，几乎达到了自引力成球的极限。', facts: ['1989 年由旅行者 2 号发现。'], researchQuery: 'Proteus Neptune moon' },
  nereid: { massKg: 3.1e19, densityGcm3: 1.5, gravity: 0.07, escapeKms: 0.16, shape: 'irregular', desc: '拥有太阳系卫星中最偏心的轨道之一（e≈0.75）。', facts: ['可能被海卫一捕获过程扰动过。'], researchQuery: 'Nereid eccentric orbit' },
  charon: { massKg: 1.586e21, densityGcm3: 1.702, gravity: 0.288, escapeKms: 0.59, tempK: 53, albedo: 0.38, texture: 'charon.jpg', desc: '冥王星最大的卫星，两者互相潮汐锁定，围绕共同质心旋转，构成事实上的双矮行星系统。', facts: ['北极区有红色的索林（tholin）沉积。'], researchQuery: 'Charon Pluto binary system' },
  nix: { texture: 'nix.jpg', shape: 'elongated', desc: '冥王星的小卫星，2005 年与许德拉一同被哈勃望远镜发现，形状不规则且自转混乱。', facts: ['表面亮度不均，可能覆盖水冰。'], researchQuery: 'Nix Pluto moon' },
  hydra: { shape: 'irregular', desc: '冥王星最外侧的已知卫星，表面水冰反射率很高。', facts: ['新视野号 2015 年拍到了它。'], researchQuery: 'Hydra Pluto moon' },
  kerberos: { shape: 'irregular', desc: '冥王星的小卫星，比预想的更暗更小。', facts: ['2011 年由哈勃望远镜发现。'], researchQuery: 'Kerberos Pluto moon' },
  styx: { shape: 'irregular', desc: '冥王星最内侧的已知小卫星，2012 年由哈勃望远镜发现。', facts: ['以冥河斯堤克斯命名。'], researchQuery: 'Styx Pluto moon' },
  dysnomia: { desc: '阋神星唯一的卫星，直径约 700 公里，是已知矮行星卫星中较大的一颗。', facts: ['由它绕阋神星的轨道推算出了阋神星的质量。'], researchQuery: 'Dysnomia Eris moon' },
  hiiaka: { desc: '妊神星较大的卫星，表面覆盖近乎纯净的水冰。', facts: ['可能形成于一次巨大撞击的碎片。'], researchQuery: "Hi'iaka Haumea moon" },
  namaka: { desc: '妊神星较小的卫星，轨道受希亚卡扰动而明显偏离。', facts: ['轨道偏心率约 0.25。'], researchQuery: 'Namaka Haumea moon' },
  mk2: { desc: '鸟神星唯一的卫星，2015 年由哈勃望远镜发现，是暗色的冰块天体。', facts: ['亮度只有鸟神星的 1/1300。'], researchQuery: 'Makemake MK2 moon' },
  xiangliu: { desc: '共工星的卫星，以中国神话中的九头蛇相柳命名。', facts: ['2016 年由哈勃望远镜发现。'], researchQuery: 'Xiangliu Gonggong moon' },
  weywot: { desc: '创神星的卫星，以汤加神话中的神祇命名。', facts: ['2023 年创神星环的发现者正是研究这颗卫星时注意到的。'], researchQuery: 'Weywot Quaoar moon' },
  vanth: { desc: '亡卫星（Orcus）的卫星，直径约 440 公里，表面呈暗红色。', facts: ['与母星形成双星系统。'], researchQuery: 'Vanth Orcus moon' },
  actaea: { desc: '萨拉喀亚的卫星，平均密度与水冰接近。', facts: ['2006 年由哈勃望远镜发现。'], researchQuery: 'Actaea Salacia moon' },
  ilmare: { desc: '瓦尔达的卫星，以《魔戒》中精灵宝钻的故乡命名。', facts: ['轨道周期约 5.75 天。'], researchQuery: 'Ilmarë Varda moon' },
};

const GROUP_LABEL = {
  major: '主要卫星', galilean: '伽利略卫星', inner: '内侧小卫星',
  ring: '环系牧羊卫星', trojan: '特洛伊伴星', irregular: '不规则卫星',
};

export const MOONS = TABLE.map(([id, name, en, parent, radiusKm, aKm, e, incline, periodDays, color, grp]) => {
  const detail = DETAIL[id] || {};
  const b = {
    id, name, en, parent, radiusKm, aKm, e, incline, periodDays, color, grp,
    node: detail.node ?? 0,
    phase: detail.phase ?? (id.charCodeAt(0) * 37) % 360,
    ...detail,
  };
  if (b.hidden === undefined) b.hidden = radiusKm < 12 || grp === 'irregular';
  if (!b.desc) {
    const dia = Math.round(radiusKm * 2);
    b.desc = `${GROUP_LABEL[grp] || '卫星'}。平均直径约 ${dia} 公里，平均轨道半径 ${(aKm / 1000).toFixed(0)} 千公里，`
      + `公转周期 ${periodDays < 1 ? periodDays.toFixed(3) : periodDays.toFixed(2)} 天。`;
  }
  if (!b.facts) b.facts = [];
  if (!b.researchQuery) b.researchQuery = `${en} moon ${parent}`;
  return b;
});

export const MOON_GROUP_LABEL = GROUP_LABEL;

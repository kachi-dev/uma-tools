import { h } from 'preact';

import './IntroText.css';



export function INTRO(props){
	return(
		<div id="REALINTROTEXT">

			
		</div>


	)


}




export function IntroText(props) {
	return (
		<div id="introtext">
			<details>
				<summary>Caveats</summary>
				The simulator is fairly complete and implements nearly all relevant game mechanics, with the following exceptions:
				<ul>
					<li>
						<details>
							<summary>Spot Struggle ignores LaneGap activation condition and is based solely on the distance between umas.</summary>
							<p>Due to the difficulty of accurately simulating lane movement, Spot Struggle is activated when two or more Front Runner umas are within 3.75m of one another (5m for Runaway).</p>
							<p>We do simulate lane movement, however, this is simply an approximation for the purpose of determining the effectiveness of lane movement skills post 1st-anniversary.</p>
						</details>
					</li>

					<li>
						<details>
							<summary>Early-race lane movement is simulated approximately as this mechanic is dependent on other umas in the race.</summary>
							<p>Specifically, your lane movement largely depends on overtake targets and blocking.</p>
							<p>We have used logic from the mee1080 race simulator to approximate lane movement for the purposes of observing the effect of certain lane movement skills, however, it is not accurate enough to use for mechanics like Spot Struggle and Dueling.</p>
						</details>
					</li>

					<li>
						<details>
							<summary>Pseudo-random skills based on the location of other umas use a best-effort estimation for the distribution of their activation locations which may not be perfectly reflective of in-game behavior in all circumstances</summary>
							<p>Skills that have conditions that require you to be blocked, are based on other umas in your proximity, etc, are modeled according to statistical distributions intended to simulate their in-game behavior but may not be perfectly accurate. It should always find the correct minimum and maximum but the reported mean and median should sometimes be taken with a grain of salt. For example skills with blocked conditions are generally better in races with more umas and worse with fewer. Use your better judgement.</p>
							<p>Skills with conditions with <code>_random</code> in the name (e.g. <code>phase_random</code>, <code>corner_random</code>, <code>straight_random</code>) are implemented identically to the in-game logic and will have more accurate mean/median values, as are skills based purely on the course geometry with no blocked front/side/surrounded conditions.</p>
						</details>
					</li>

					<li>
						<details>
							<summary>Skill cooldowns are not implemented</summary>
							Skills only ever activate once even if they have a cooldown like Professor of Curvature or Beeline Burst. 
						</details>
					</li>
					<li>
						<details>
							<summary>Unique skill scaling with levels is not implemented</summary>
							Unique skills are always simulated as a base level 3★ unique.
						</details>
					</li>
				</ul>
				By and large it should be highly accurate. It has been battle-tested on the JP server for several years.
			</details>
			<details open={true}>
				<summary>Changelog</summary>
				<section>
					<h2>2025-12-06</h2>
					<ul>
						<li>
							<details>
								<summary>Removed Wit Variance toggle as it is no longer relevant - wit-related mechanics are now always enabled.</summary>
								If you still want to observe race variance where skills proc in different locations, or 1 uma procs a recovery skill and the other doesn't, you can turn off 'Sync RNG' - though this means you will need to run more samples to achieve accurate mean/median length results.
							</details>
						</li>
						<li>Synced fork with alpha123 latest changes.</li>
					</ul>
				</section>
				<section>
					<h2>2025-11-30</h2>
					<ul>
						<li>Fixed non-full spurts always being delayed by 60m.</li>
						<li>Added cute utools graphs to skill/uma chart when you click on a skill.</li>
					</ul>
				</section>
				<section>
					<h2>2025-11-29</h2>
					<ul>
						<li>Updated global data.</li>
						<li>Fixed umalator target speed clamping during deceleration.</li>
						<li>Fixed last spurt candidate selection logic.</li>
						<li>Fixed skills that target other umas (i.e. HRice unique) causing desync issues with skill charts.</li>
					</ul>
				</section>
				<section>
					<h2>2025-11-14</h2>
					<ul>
						<li>Updated skill/uma/track data to latest global version.</li>
						<li>Added Spot Struggle simulation.</li>
						<li>Added basic lane movement simulation (primarily for Dodging Danger/Prudent Positioning).</li>
						<li>Added spurt/stamina survival rate. Initial comparisons with in-game spurt rate shows that vfalator is actually more accurate than mee1080, but more testing is needed.</li>
						<li>Fixed start delay logic.</li>
						<li>Fixed early-race velocity bug causing umas to accelerate faster than they should.</li>
						<li>... and probably other stuffs I forgot since there hasn't been a changelog in a while...</li>
					</ul>
				</section>
				<section>
					<h2>2025-10-09</h2>
					<ul>
						<li>Fixed downhills not working</li>
					</ul>
				</section>
				<section>
					<h2>2025-10-07</h2>
					<ul>
						<li>Implemented rushed status effect</li>
						<li>Implemented downhill speed-up mode along with the 60% HP consumption reduction. Special thanks to Transparent Dino and Justus0246 for the math</li>
						<li>Virtual pacemaker for nerds who want to relive the glory days of Urara PDM</li>
						<li>YOU CAN NOW FORCE SKILLS ACTIVATIONS AT CERTAIN DISTANCES!!! LIKE PROFESSOR OF CURVATURE ON A STRAIGHT!</li>
						<li>Enhanced Spurt Calculations coded by Transparent Dino, used the Me1080 formula</li>
					</ul>
				</section>
				<section>
					<h2>2025-08-17</h2>
					<ul>
						<li><strong>Fix to use proper data for hills from the current global version instead of an approximation using data from a later patch</strong> (thanks to <a href="https://github.com/mikumifa">mikumifa</a>)</li>
						<li>Update game data</li>
						<li>Fix a bug where very low stamina on long courses could cause the simulator to freeze</li>
					</ul>
				</section>
				<section>
					<h2>2025-07-28</h2>
					<ul>
						<li>Add caveats section describing the implementation of the simulator</li>
						<li>Allow selecting debuff skills multiple times to simulate multiple debuffers</li>
						<li>Minor UI improvements</li>
					</ul>
				</section>
				<section>
					<h2>2025-07-26</h2>
					<ul>
						<li>Update Tokyo 2400m course to remove the hill at the start to match a game bug where skills do not activate on that hill or the hill does not exist</li>
						<li>Implement per-section int roll target speed modifier</li>
						<li>Simulate skills with the post_number condition more accurately</li>
						<li>Implement the random_lot condition (used by Lucky Seven/Super Lucky Seven)</li>
						<li>Minor UI improvements</li>
					</ul>
				</section>
				<section>
					<h2>2025-07-21</h2>
					<ul>
						<li>Update game data</li>
						<li>Implement debuff skills</li>
						<li>
							<details>
								<summary>Fix the implementation of skills with the corner_random condition to be more accurate to mechanics of the global release</summary>
								Primarily affects Swinging Maestro/Corner Recovery, Professor of Curvature/Corner Adept, and the strategy/distance corner skills
							</details>
						</li>
						<li>Fix an issue where skills weren't displayed on the chart if they were still active at the end of a simulation run</li>
						<li>Added changelog</li>
						<li>Minor UI fixes</li>
					</ul>
				</section>
				<section>
					<h2>2025-07-17</h2>
					<ul>
						<li>Run simulations in a background thread for responsiveness</li>
						<li>
							<details>
								<summary>Major improvements to the skill chart mode</summary>
								<ul>
									<li>Click rows in the skill efficacy table to show that run on the course chart</li>
									<li>Radio buttons in table headers to select the statistic displayed on the course chart</li>
									<li>Show a popup with skill information and length histogram when clicking icons in the skill efficacy table</li>
									<li>Double-click rows on the skill efficacy table to add them to the simulated uma musume</li>
								</ul>
							</details>
						</li>
						<li>Changes to the skill chart mode to feel more responsive</li>
					</ul>
				</section>
				<section>
					<h2>2025-07-16</h2>
					<ul>
						<li>Initial implementation of the skill chart mode</li>
					</ul>
				</section>
				<section>
					<h2>2025-07-13</h2>
					<ul>
						<li>Initial release of the global version</li>
						<li>Miscellaneous UI improvements</li>
						<li>Bug fixes</li>
					</ul>
				</section>
			</details>
			<details>
				<summary>Credits</summary>
					<h1>Transparent Dino</h1>
					<p>Enhanced Spurt calculator (taken from mee1080), Virtual Pacemaker, Downhills, Rushed</p>
					<h1>jechtoff2dudes</h1>
					<p>Frontrunner Overtake/Speedup mode, Dragging Skill Markers, Downhills, Skill Activation check</p>
					<h1>Kachi</h1>
					<p>Fixing all the bugs and UI issues, mood, UI improvements, rewriting poskeep, reworking RNG, uniques chart (utools at home), spot struggle/dueling, lane movement</p>
			</details>
			<footer id="sourcelinks">
				Original Umalator Source code: <a href="https://github.com/alpha123/uma-skill-tools">simulator</a>, <a href="https://github.com/alpha123/uma-tools">UI</a>
			</footer>
		</div>
	);
	;}

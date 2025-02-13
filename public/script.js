
document.addEventListener('DOMContentLoaded', () => {
    // Fetch and display events from TicketSource API
    const fetchEvents = async (eventRef, containerId) => {
        try {
            const response = await fetch(`https://api.ticketsource.io/v1/events?reference=${eventRef}`, {
                headers: {
                    "Authorization": "Bearer skl-J9fLpV5K6RoPnQbCFALr16aANibrWRf4OhxwxENOUu2NFWNtEJdvm8FLNgpa",
                    "Content-Type": "application/json"
                }
            });
            const data = await response.json();
            const container = document.getElementById(containerId);
            container.innerHTML = data.events.map(event => `
                <div class="event">
                    <h3>${event.name}</h3>
                    <p>${event.description}</p>
                    <a href="${event.ticket_url}" target="_blank">Book Tickets</a>
                </div>
            `).join('');
        } catch (error) {
            console.error('Error fetching events:', error);
        }
    };

    // Initialize API data for each section
    fetchEvents('General', 'general-events');
    fetchEvents('Summer', 'summer-events');
    fetchEvents('Halloween', 'halloween-events');
});
<<<<<<< HEAD
=======
// Hamburger Menu Functionality for Mobile Portrait Mode
const hamburger = document.getElementById("hamburger");
const menu = document.getElementById("menu");

hamburger.addEventListener("click", function () {
    // Toggle menu visibility when hamburger is clicked
    menu.classList.toggle("open");
});

// Optional: Close the menu if clicking outside
document.addEventListener("click", function (e) {
    if (!hamburger.contains(e.target) && !menu.contains(e.target)) {
        menu.classList.remove("open");
    }
});

>>>>>>> 24eaae6cc04cc7ee532e6e015d6ffa01ab367058
